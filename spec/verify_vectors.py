#!/usr/bin/env python3
"""
Verify the committed test vectors with the INDEPENDENT Python reader: proof the
format is portable, not tied to the TypeScript runtime. Run from spec/:

    pip install argon2-cffi cryptography
    python3 verify_vectors.py

Exits non-zero on any mismatch.
"""
import base64
import json
import sys

import selfstore_reader as R


def _fresh_outsider() -> dict:
    """A structurally valid X25519 identity that is NOT a recipient."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    priv = X25519PrivateKey.generate()
    return {
        "encPriv": base64.b64encode(priv.private_bytes(
            serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption())).decode(),
        "encPub": base64.b64encode(priv.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode(),
    }


def main() -> int:
    manifest = json.load(open("vectors/manifest.json"))
    expected = manifest["expected"]
    group = manifest.get("group", {})
    identities = group.get("identities", {})
    for fname, props in manifest["files"].items():
        data = open("vectors/" + fname, "rb").read()
        if props.get("keying"):  # group mode: every recipient must open it
            author_id = group["author"]
            author_key = identities[author_id]["sigPub"]
            for member, identity in identities.items():
                snap = R.read(data, identity=identity, authors=[author_key])
                assert snap["author"] == author_key, f"{fname}: author ({member})"
                assert snap["collections"] == expected["collections"], f"{fname}: collections ({member})"
            # An identity outside the recipient list must be rejected.
            try:
                R.read(data, identity=_fresh_outsider(), authors=[author_key])
                raise AssertionError(f"{fname}: outsider identity accepted")
            except R.SelfstoreError:
                pass
            print(f"{fname}: OK (all {len(identities)} recipients + rejection)")
            continue
        # An envelope lists several password slots: EVERY one must open the
        # file. Plain vectors carry the single canonical password.
        if props["encryption"] == "none":
            passwords = [None]
        else:
            passwords = props.get("passwords", [manifest["password"]])
        for password in passwords:
            snap = R.read(data, password)

            assert snap["collections"] == expected["collections"], f"{fname}: collections"
            assert snap["app"] == manifest["app"], f"{fname}: app"
            by_id = {f["id"]: f for f in snap["files"]}
            for ef in expected["files"]:
                got = by_id[ef["id"]]
                assert got["name"] == ef["name"] and got["mime"] == ef["mime"], f"{fname}: file meta"
                assert got["bytes"].decode("utf-8") == ef["text"], f"{fname}: file bytes"
            assert ("sync" in snap) == props["hasSyncJson"], f"{fname}: sync.json presence"
        if props["encryption"] != "none":
            # And a wrong password must fail closed, never partially read.
            try:
                R.read(data, "definitely-not-the-password")
                raise AssertionError(f"{fname}: wrong password accepted")
            except R.SelfstoreError:
                pass
        # An external-key slot (SPEC 13.7): the fixed secret opens the same file,
        # and a wrong secret fails closed - proof the HKDF wrap is portable too.
        ext = props.get("external")
        if ext:
            secret = base64.b64decode(ext["secretB64"])
            snap = R.read(data, secret=secret)
            assert snap["collections"] == expected["collections"], f"{fname}: external collections"
            try:
                R.read(data, secret=bytes(len(secret)))  # all-zero secret, right length
                raise AssertionError(f"{fname}: wrong external secret accepted")
            except R.SelfstoreError:
                pass
        label = f" ({len(passwords)} password(s){', external key' if ext else ''})" \
            if props["encryption"] != "none" else ""
        print(f"{fname}: OK{label}")

    print("ALL VECTORS VERIFIED by the independent Python reader")
    return 0


if __name__ == "__main__":
    sys.exit(main())
