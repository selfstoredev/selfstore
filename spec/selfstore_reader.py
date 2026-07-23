#!/usr/bin/env python3
"""
Reference reader for the selfstore backup format, in ~120 lines of Python. It is
INDEPENDENT of the TypeScript library: if this reads a file that library wrote,
the format is genuinely portable and not tied to one runtime. See SPEC.md for the
normative description; this is the executable companion.

Dependencies (reference reader only, never shipped in the npm package):
    pip install argon2-cffi cryptography

Usage:
    python3 selfstore_reader.py backup.zip [password]
    python3 selfstore_reader.py group-copy.zip identity.json   # group mode (format 2):
        identity.json = {"encPub": "<b64 raw>", "encPriv": "<b64 pkcs8>"}

Password-envelope backups (format 3, several password slots opening one file)
read with the same password argument: any listed password works.
"""
import base64
import hashlib
import io
import json
import sys
import zipfile

# --- Format constants (see SPEC.md) ---
META = "meta.json"          # cleartext header (both modes)
MANIFEST = "selfstore.json"  # app collections + file list (plain mode / inner zip)
DATA = "data.enc"           # AES-256-GCM ciphertext+tag (encrypted mode)
SIG = "sig.bin"             # group mode: author's Ed25519 signature
SYNC = "sync.json"          # optional opaque bookkeeping; a reader ignores it
FILES = "files/"            # one entry per binary file, keyed by id
KEY_LEN = 32                # AES-256
MAX_KDF = {"m": 1024 * 1024, "t": 10, "p": 4}  # read-side ceiling (KiB, passes, lanes)
GROUP_KEYING = "x25519-hkdf-sha256"            # group mode key envelope
MAX_RECIPIENTS = 256                           # envelope-count cap (DoS guard)
MAX_KEY_SLOTS = 8                              # format 3: each slot is one open trial
DOMAIN_BOX = b"selfstore-group-sig-v1"         # signature domain separation
HKDF_INFO = b"selfstore-group-wrap-v1"         # stanza wrap-key derivation info
EXTERNAL_INFO = b"selfstore-external-slot-v1"  # external-slot KEK derivation info
MIN_EXTERNAL_SECRET = 16                        # floor on a caller-supplied secret


class SelfstoreError(Exception):
    pass


def _read_manifest(zf: zipfile.ZipFile) -> dict:
    """Turn an inner archive (plain zip bytes) into {app-less} snapshot dict."""
    manifest = json.loads(zf.read(MANIFEST))
    files = []
    for f in manifest.get("files", []):
        files.append({**f, "bytes": zf.read(FILES + f["id"])})
    out = {"collections": manifest.get("collections", {}), "files": files}
    if SYNC in zf.namelist():                     # opaque bookkeeping: expose, do not require
        out["sync"] = json.loads(zf.read(SYNC))
    return out


def _derive_key(password: str, kdf: dict) -> bytes:
    from argon2.low_level import hash_secret_raw, Type
    if kdf.get("algo") != "argon2id":
        raise SelfstoreError(f"unsupported KDF: {kdf.get('algo')!r}")
    m, t, p = kdf["m"], kdf["t"], kdf["p"]
    if m > MAX_KDF["m"] or t > MAX_KDF["t"] or p > MAX_KDF["p"]:
        raise SelfstoreError(f"KDF parameters out of range: m={m} t={t} p={p}")
    return hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=base64.b64decode(kdf["salt"]),
        time_cost=t, memory_cost=m, parallelism=p,
        hash_len=KEY_LEN, type=Type.ID, version=19,  # Argon2 v1.3 (0x13)
    )


def _derive_external_kek(secret: bytes) -> bytes:
    """External-slot KEK (SPEC 13.7): the caller's secret is already high-entropy,
    so a single HKDF-SHA256 expansion (empty salt, fixed info) - no Argon2."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    if len(secret) < MIN_EXTERNAL_SECRET:
        raise SelfstoreError(f"external secret too short (min {MIN_EXTERNAL_SECRET} bytes)")
    return HKDF(algorithm=hashes.SHA256(), length=KEY_LEN,
                salt=b"", info=EXTERNAL_INFO).derive(secret)


def _open_group(zf: zipfile.ZipFile, header: dict, identity: dict, authors: list | None) -> dict:
    """Group mode (format 2). Trust order: author membership, then the Ed25519
    signature over the EXACT meta.json + data.enc bytes, then the recipient
    envelope, then AES-GCM. See SPEC.md section 12."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.serialization import load_der_private_key

    if header.get("keying") != GROUP_KEYING:
        raise SelfstoreError(f"unsupported keying: {header.get('keying')!r}")
    if header.get("format") != 2:
        raise SelfstoreError("group keying present but format is not 3")
    # A valid signature over an attacker-chosen author proves nothing (SPEC 12.6):
    # the trusted-author list is MANDATORY for group mode. Never open without it.
    if authors is None:
        raise SelfstoreError("group copy: a trusted-author list is required")
    author = header["author"]
    if author not in authors:
        raise SelfstoreError("author is not a trusted group member")
    recipients = header.get("recipients") or []
    if len(recipients) > MAX_RECIPIENTS:
        raise SelfstoreError(f"too many recipient stanzas (max {MAX_RECIPIENTS})")
    meta_bytes, data_enc, sig = zf.read(META), zf.read(DATA), zf.read(SIG)
    msg = DOMAIN_BOX + hashlib.sha256(meta_bytes).digest() + hashlib.sha256(data_enc).digest()
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(author)).verify(sig, msg)
    except InvalidSignature:
        raise SelfstoreError("copy signature verification failed")

    priv = load_der_private_key(base64.b64decode(identity["encPriv"]), password=None)
    my_pub = base64.b64decode(identity["encPub"])
    my_kid = base64.b64encode(hashlib.sha256(my_pub).digest()[:8]).decode()
    stanzas = [s for s in recipients if s["kid"] == my_kid] or recipients
    data_key = None
    for s in stanzas:
        try:
            epk = base64.b64decode(s["epk"])
            shared = priv.exchange(X25519PublicKey.from_public_bytes(epk))
            wrap_key = HKDF(algorithm=hashes.SHA256(), length=KEY_LEN,
                            salt=epk + my_pub, info=HKDF_INFO).derive(shared)
            unwrapped = AESGCM(wrap_key).decrypt(
                base64.b64decode(s["iv"]), base64.b64decode(s["wrap"]), None)
            if len(unwrapped) == KEY_LEN:  # enforce 32-byte AES-256 data key; reject a downgrade
                data_key = unwrapped
                break
        except Exception:
            continue  # not our stanza: try the next candidate
    if data_key is None:
        raise SelfstoreError("no envelope opens for this identity (not a recipient)")
    inner = AESGCM(data_key).decrypt(base64.b64decode(header["iv"]), data_enc, None)
    with zipfile.ZipFile(io.BytesIO(inner)) as innerzf:
        snap = _read_manifest(innerzf)
    snap["author"] = author
    return snap


def _open_envelope(zf: zipfile.ZipFile, header: dict, password: str | None,
                   secret: bytes | None = None) -> dict:
    """Password/external envelope (format 3, authenticated header). Bounds first
    (slot count, then each slot's KDF ceiling), then one trial per slot until one
    unwraps the 32-byte data key: a password slot runs Argon2id with `password`, an
    external slot (kind=='external') derives its KEK by HKDF from `secret`. Format 5
    binds the exact meta.json bytes as the data.enc GCM AAD, so the slot table
    cannot be stripped or altered by a party with write access. See SPEC section 13."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if header.get("encryption") != "aes-256-gcm":
        raise SelfstoreError("password envelope requires aes-256-gcm encryption")
    slots = header.get("keys")
    if not isinstance(slots, list) or not slots:
        raise SelfstoreError("password envelope requires a non-empty keys[] slot table")
    if len(slots) > MAX_KEY_SLOTS:
        raise SelfstoreError(f"too many key slots (max {MAX_KEY_SLOTS})")
    if password is None and secret is None:
        raise SelfstoreError("backup is encrypted; a password or an external secret is required")
    data_key = None
    for slot in slots:
        if slot.get("kind") == "external":
            if secret is None:
                continue  # no secret in hand for an external slot: try the next
            kek = _derive_external_kek(secret)
        else:
            if password is None:
                continue  # no password for a password slot: try the next
            kek = _derive_key(password, slot["kdf"])  # enforces algo + the KDF ceiling
        try:
            unwrapped = AESGCM(kek).decrypt(
                base64.b64decode(slot["iv"]), base64.b64decode(slot["wrapped"]), None)
        except Exception:
            continue  # not this slot's key: try the next
        if len(unwrapped) == KEY_LEN:  # exactly 32 bytes; reject a downgrade
            data_key = unwrapped
            break
    if data_key is None:
        raise SelfstoreError("wrong key (no key slot opened), or corrupted backup")
    # The header is authenticated: the exact meta.json bytes are the GCM AAD,
    # so a stripped or altered slot table fails the tag.
    aad = zf.read(META)
    inner = AESGCM(data_key).decrypt(base64.b64decode(header["iv"]), zf.read(DATA), aad)
    with zipfile.ZipFile(io.BytesIO(inner)) as innerzf:
        return _read_manifest(innerzf)


def read(data: bytes, password: str | None = None,
         identity: dict | None = None, authors: list | None = None,
         secret: bytes | None = None) -> dict:
    """Read a selfstore backup into {app, schemaVersion?, collections, files, sync?}.
    Group copies (format 2) need `identity`; pass `authors` to pin trusted signers.
    External-key slots (SPEC 13.7) need the 32-byte `secret` instead of a password."""
    if not data[:4] == b"PK\x03\x04":
        raise SelfstoreError("not a ZIP archive")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        header = json.loads(zf.read(META))
        fmt = header.get("format", 1)
        if fmt not in (1, 2, 3):
            raise SelfstoreError(f"format v{fmt} is not supported by this reader")
        # Mode binds to the format id, both ways (SPEC 12.6, 13.5): a stripped or
        # forged format field must not route a box down a weaker path.
        if (fmt == 2) != (header.get("keying") is not None):
            raise SelfstoreError("group mode (format 2) and the keying field must agree")
        if (fmt == 3) != isinstance(header.get("keys"), list):
            raise SelfstoreError("password envelope (format 3) and the keys field must agree")
        enc = header.get("encryption", "none")

        if header.get("keying") is not None:
            if identity is None:
                raise SelfstoreError("group copy: a member identity is required")
            snap = _open_group(zf, header, identity, authors)
        elif fmt == 3:
            snap = _open_envelope(zf, header, password, secret)
        elif enc == "none":
            snap = _read_manifest(zf)
        else:
            # Encrypted content in a container claiming the plain format: never
            # written by a conforming writer.
            raise SelfstoreError("encrypted content in a plain-format container")

    snap["app"] = header.get("app")
    if "schemaVersion" in header:
        snap["schemaVersion"] = header["schemaVersion"]
    return snap


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1], "rb") as fh:
        data = fh.read()
    password, identity = None, None
    if len(sys.argv) > 2:
        if sys.argv[2].endswith(".json"):  # group mode: an identity file
            identity = json.load(open(sys.argv[2]))
        else:
            password = sys.argv[2]
    snap = read(data, password, identity)
    print(f"app: {snap.get('app')}  schemaVersion: {snap.get('schemaVersion')}")
    if "author" in snap:
        print(f"author (verified): {snap['author']}")
    for name, rows in snap["collections"].items():
        print(f"collection {name!r}: {len(rows)} record(s)")
    for f in snap["files"]:
        print(f"file {f['id']} ({f['name']}, {f['mime']}): {len(f['bytes'])} bytes")


if __name__ == "__main__":
    main()
