# selfstore backup format specification

A backup is exactly one of three shapes, and the container generation is the
discriminant: **1** = a plain (unencrypted) ZIP, **2** = group mode (section
12), **3** = the authenticated password envelope (section 13, the shape every
writer emits for password mode). This document specifies the on-disk format
precisely enough to
implement a reader or writer in any language, independent of the reference
TypeScript library. An executable companion lives in
[`spec/selfstore_reader.py`](./spec/selfstore_reader.py) (a small Python
reader) with canonical [test vectors](./spec/vectors/).

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as in
RFC 2119.

## 1. Goals

- **Portable.** A backup is a normal ZIP. Unencrypted, it opens in any archive
  tool; encrypted, it still opens as a ZIP (a readme plus the ciphertext), never
  an opaque blob.
- **Self-describing.** A cleartext header states how to read the rest, so a
  reader routes each backup to the right mode and refuses a generation it does
  not understand cleanly, never guessing.
- **Schema-agnostic.** The format carries named collections of opaque JSON
  documents plus binary files. It never interprets the documents.
- **Authenticated encryption.** When a password is set, confidentiality and
  integrity come from AES-256-GCM over an Argon2id-derived key.

## 2. Container

A backup is a ZIP archive (local-file-header magic `50 4B 03 04`). Two modes:

| Mode | Entries |
|---|---|
| Unencrypted | `meta.json`, `selfstore.json`, `files/<id>` (0+), `sync.json` (optional) |
| Encrypted | `meta.json`, `data.enc`, and a readme (e.g. `LISEZMOI.txt`) |

In encrypted mode the manifest, files and optional `sync.json` are NOT outer
entries: they form an INNER ZIP that is encrypted whole into `data.enc`. Thus the
same logical contents (`selfstore.json` + `files/` + optional `sync.json`) appear
either directly (unencrypted) or inside `data.enc` (encrypted). Compression MAY
be applied to any entry except `data.enc`, which SHOULD be stored (level 0) since
ciphertext does not compress. Readers MUST NOT assume entry ordering and MUST
ignore unknown entries.

## 3. `meta.json` (the cleartext header)

UTF-8 JSON, present in every mode, always cleartext. The common fields:

```jsonc
{
  "format": 1,                      // container generation (integer). Absent => 1.
  "app": "spec-demo",               // writing app id (string)
  "appVersion": "1.0.0",            // OPTIONAL, informational release string
  "schemaVersion": 1,               // OPTIONAL, the app's DATA schema version (integer)
  "createdAt": "2026-07-09T...Z",   // ISO 8601 timestamp
  "encryption": "none"              // "none" (format 1) | "aes-256-gcm" (format 2 or 3)
}
```

An encrypted header carries mode-specific fields on top of these: the password
envelope (format 3) adds `keys[]` and `iv` (section 13.2); group mode (format
2) adds `keying`, `author`, `recipients` and `iv` (section 12.2). There is no
top-level `kdf`: the key derivation lives per slot in the envelope.

**Authentication boundary.** For an encrypted backup, AES-GCM authenticates
`data.enc`; its effective parameters (the wrapping slot's `kdf`/`iv`, or the
group `iv`) are the decrypt inputs, so altering them makes authentication
fail. In the **authenticated password envelope (format 3)** the entire cleartext
header is bound too: the exact `meta.json` bytes are passed as the `data.enc`
GCM additional authenticated data (AAD), so ANY change to the header - the
`keys[]` slot table above all, but also every cosmetic field - fails the tag.
In group mode the header is covered instead by the author's signature (section
12.3).

## 4. `selfstore.json` (the manifest)

UTF-8 JSON. In unencrypted mode it is an outer entry; in encrypted mode it is
inside the decrypted inner ZIP.

```jsonc
{
  "version": 1,                     // manifest schema version (integer), distinct from meta.format
  "collections": {                  // named arrays of opaque JSON documents
    "notes": [ { "id": "n1", "text": "hello world" } ]
  },
  "files": [                        // metadata for each binary file (bytes live under files/<id>)
    { "id": "f1", "name": "a.txt", "mime": "text/plain" }
  ]
}
```

Each `files[]` entry's bytes are stored as the ZIP entry `files/<id>` (keyed by
`id`, not `name`). A document's identity, for multi-device merge, is a STRING id
field (default `id`); the format itself does not require one, but a document with
no string id cannot participate in merge.

## 5. `files/<id>`

The raw bytes of one binary file, one ZIP entry per file, named `files/` + the
file's `id`. A reader reconstructs each file by joining `files[]` metadata (name,
mime) with these bytes.

## 6. `sync.json` (optional, opaque)

Present when the writer maintains multi-device merge state (the reference
`createLocalStore` does). UTF-8 JSON of the shape `{ "schemaVersion": <int>,
"meta": <merge-metadata> }`. It rides inside the encrypted envelope when
encrypted. A reader that only wants the data MUST ignore it; its internal shape
is not part of this format's normative surface. Backups written before this
generation carried the same bookkeeping as a reserved `__store` collection inside
`selfstore.json`; a reader MAY strip a `__`-prefixed collection for compatibility.

## 7. Cryptography primitives (shared by encrypted modes)

Both encrypted modes seal the inner ZIP with the same primitives; the password
envelope (section 13) wraps the sealing key per password, group mode (section
12) per recipient.

- **KDF:** Argon2id, version `0x13` (19). Inputs: the UTF-8 password bytes; the
  16-byte `salt`; cost `m` (KiB), `t`, `p`. Output: a 32-byte key. In the
  password envelope these parameters live per slot (section 13.2).
- **Cipher:** AES-256-GCM. The 96-bit `iv` is the header `iv`. Associated data is
  empty. `data.enc` is the GCM ciphertext with the 16-byte authentication tag
  APPENDED (the WebCrypto convention): `data.enc = ciphertext || tag`. A reader
  passes `data.enc` unchanged to a GCM implementation that expects the tag
  appended (e.g. Python `AESGCM.decrypt`); implementations that take the tag
  separately MUST split off the last 16 bytes.
- The decrypted plaintext is the inner ZIP (section 2).
- New writers MUST use fresh random `salt` and `iv` per write (per slot in the
  envelope). Default cost is `m = 47104` (46 MiB), `t = 3`, `p = 1`; writers
  MAY use stronger, and per-slot parameters mean an old slot keeps opening when
  defaults change.

## 8. Read algorithm (normative)

1. If the bytes do not begin with `50 4B 03 04`, fail `BAD_FORMAT` (it is not a
   ZIP).
2. Parse `meta.json`. If `format` (default 1) is not 1, 2 or 3, fail
   `UNSUPPORTED_VERSION`. If `encryption` is neither `none` nor
   `aes-256-gcm`, or any slot's `kdf.algo` is not `argon2id`, fail
   `UNSUPPORTED_VERSION`. Bind mode to the format id, both ways: `keying`
   present iff `format` is 2, `keys` present iff `format` is 3; a mismatch is
   `BAD_FORMAT` (section 12.6, 13.5).
3. If the format is 2 (group mode), continue at section 12.5. If it is 3
   (password envelope), continue at section 13.4.
4. If `encryption` is `none`: read `selfstore.json` and each `files/<id>` from the
   archive.
5. Otherwise the header claims the plain format but carries encrypted content:
   never written by a conforming writer. Fail `BAD_FORMAT`.
6. Ignore `sync.json` and any unknown entries unless implementing merge.

## 9. Reader security requirements

- **KDF ceiling.** A reader MUST refuse Argon2id parameters above `m = 1 GiB`
  (1048576 KiB), `t = 10`, `p = 4` before allocating the KDF, so a crafted file
  cannot exhaust memory just by being opened. Refuse as `UNSUPPORTED_VERSION`.
- **Inflation guard.** A reader MUST refuse any single entry declaring more than
  512 MiB, and SHOULD cap the aggregate of declared entry sizes (the reference
  caps at 1 GiB), failing `TOO_LARGE` before inflation.
- **Downgrade guard.** An application that expects an encrypted backup MUST refuse
  one whose header declares `encryption: none` rather than loading the plaintext.
- **Fail closed.** A wrong password and a tampered ciphertext are
  indistinguishable by design (both `DECRYPT_FAILED`). There is no partial read.

## 10. Versioning

`meta.format` is the container generation: 1 (plain), 2 (group mode, section
12) and 3 (authenticated password envelope, section 13). A backup with no
`format` field is a plain generation-1 ZIP. A reader MUST refuse a generation
it does not understand
(step 2) rather than guess. New OPTIONAL header fields MAY be added within a
generation; readers MUST ignore unknown fields.

Every password-sealed backup is the envelope (a single password is simply a
one-slot envelope). Writers emit generation 3 and readers accept no other
envelope generation. There is no separate single-password format - a reader
opens plain, group, and envelope backups, and refuses anything else.

## 11. Test vectors

[`spec/vectors/`](./spec/vectors/) holds five canonical backups written by the
reference library, plus `manifest.json` describing their expected decoded
content:

| Vector | Mode | Notes |
|---|---|---|
| `plain.zip` | unencrypted (generation 1) | `meta.json` + `selfstore.json` + `files/f1` |
| `store.zip` | unencrypted (generation 1) | also carries `sync.json` (opaque) |
| `group.zip` | group (generation 2) | signed by `alice`, sealed for `alice` + `bob`; their identities (private keys included, as test fixtures like the password) live in the manifest's `group` section |
| `envelope.zip` | authenticated password envelope (generation 3) | two slots; either listed password opens it (see the manifest's per-file `passwords`); the `meta.json` bytes are the `data.enc` AAD |
| `envelope-external.zip` | authenticated envelope with an external-key slot (generation 3) | one password slot AND one external-key slot on the same data key (section 13.7); the password or the fixed `external` secret in the manifest opens it |

`spec/selfstore_reader.py` reads all five; `spec/verify_vectors.py` asserts the
decoded content against the manifest (for the group vector: every recipient
opens it, an outsider is rejected; for the envelope vectors: every listed
password - and the external secret where present - opens it, a wrong one is
rejected). The reference library's own
`src/selfstore/vectors.test.ts` pins that these exact files keep reading, so a
format-breaking change fails CI on both sides.

## 12. Group mode (format generation 2)

Group mode shares one store between several people, each publishing their OWN
copy: no shared password, no shared write access. A group copy is still a
genuine ZIP with the same logical contents; what changes is the keying (public
keys instead of a KDF) and an author signature.

### 12.1 Container

| Entry | Content |
|---|---|
| `meta.json` | cleartext header (12.2) |
| `data.enc` | AES-256-GCM(inner ZIP) under a fresh random 32-byte data key, tag appended |
| `sig.bin` | the author's raw 64-byte Ed25519 signature (12.4) |
| readme | cosmetic, as in password mode |

### 12.2 Header additions

```jsonc
{
  "format": 2,
  "encryption": "aes-256-gcm",
  "keying": "x25519-hkdf-sha256",   // the data key travels in recipient stanzas
  "author": "<base64>",              // the signer's raw 32-byte Ed25519 public key
  "recipients": [                    // one stanza per recipient
    {
      "kid": "<base64>",             // first 8 bytes of SHA-256(recipient raw X25519 public)
      "epk": "<base64>",             // ephemeral raw 32-byte X25519 public (fresh per stanza)
      "iv": "<base64>",              // 12 random bytes (stanza wrap)
      "wrap": "<base64>"             // AES-256-GCM(data key), tag appended (48 bytes)
    }
  ],
  "iv": "<base64>"                   // 12 random bytes (data.enc)
}
```

`kdf` is ABSENT in group mode. The mode binding at step 2 routes a group box
only to the group path - a reader never falls through to a misleading
missing-parameter error.

### 12.3 Stanza cryptography

For each recipient, the writer generates a FRESH ephemeral X25519 keypair and
computes:

```
shared   = X25519(ephemeral_private, recipient_public)
wrap_key = HKDF-SHA256(ikm = shared,
                       salt = ephemeral_public || recipient_public,   // raw, 64 bytes
                       info = "selfstore-group-wrap-v1",
                       length = 32)
wrap     = AES-256-GCM(wrap_key, iv, data_key)                        // tag appended
```

A reader locates its stanzas by `kid` (falling back to trying all stanzas on a
collision), recomputes `wrap_key` with its private key and the stanza's `epk`,
and unwraps the data key. No stanza opening means the reader is NOT a
recipient (removed from the group, or the copy predates its joining) - a
distinct condition from a corrupt file, and reported as such.

### 12.4 Signature

```
message = "selfstore-group-sig-v1" || SHA-256(meta.json bytes) || SHA-256(data.enc bytes)
sig.bin = Ed25519-sign(author_private, message)
```

The digests cover the EXACT stored entry bytes, so everything a reader trusts -
the author claim, the recipient list, both ivs, the ciphertext - is signed.
The readme entry is cosmetic and deliberately not covered.

### 12.5 Read algorithm (normative, the continuation of section 8 step 3 for generation 2)

1. Parse `meta.json`; require `format === 2` iff `keying` is present (the mode
   and the generation MUST agree, both ways), known `encryption`, known
   `keying`.
2. A trusted-author list (the manifest members' Ed25519 publics) is
   MANDATORY. Require `author` to be in it; else fail. This check comes FIRST:
   a valid signature by an unknown key proves nothing. A reader MUST NOT offer
   a mode that opens a group copy without a pinned author list.
3. Verify `sig.bin` (12.4) against `author`. Failure is terminal.
4. Open the recipient stanza (12.3); no stanza opening is the "not a
   recipient" condition. A reader MUST cap `recipients` (the reference caps at
   256) and reject a stanza that unwraps to anything other than a 32-byte data
   key (no silent AES-128 downgrade).
5. AES-256-GCM-decrypt `data.enc` with the data key and header `iv`; read the
   inner ZIP as in generation 1.

### 12.6 Security requirements (additional)

- **Author before crypto, always pinned.** A reader MUST refuse an author
  outside the membership manifest before any signature or decryption work, and
  MUST NOT expose a group-read path that skips this (an optional author list is
  a defect: a self-declared author would be accepted).
- **Mode binds to generation.** `keying`/`author`/`recipients` appear iff
  `format === 2`; a reader MUST reject a mismatch rather than fall to a weaker
  path (e.g. a `format:2` box lacking `keying`, or a plaintext box carrying
  `keying`).
- **Bounded envelopes and 32-byte key.** A reader MUST cap the stanza count and
  reject a non-32-byte unwrapped data key.
- **Manifest hygiene.** A manifest verifier MUST reject duplicate member `id`s
  and members whose `sig`/`enc` do not decode to exactly 32 bytes, and SHOULD
  bind to the expected group id when the caller knows it.
- **Any recipient can re-encrypt.** All recipients share the data key, so GCM
  alone cannot authenticate the author - only `sig.bin` does. A reader MUST
  NOT treat a valid GCM tag as authorship.
- **Removal is forward-only.** Recipients keep what they already fetched;
  removing a member protects FUTURE publications only. Writers MUST use a
  fresh data key per publication (never reuse one across publications), which
  is what makes removal effective without a separate rekey step.
- **Membership rollback.** Consumers of a membership manifest MUST enforce a
  monotonically increasing sequence number per group id and refuse older ones.

### 12.7 Membership manifest (transport-level companion)

The manifest is not part of the container format (it never appears inside a
backup), but readers interoperate on its shape:

```jsonc
// SignedManifest - the admin signs the exact payload bytes:
//   signature = Ed25519(admin_private, "selfstore-group-manifest-v1" || payload)
{ "selfstoreManifest": 1, "payload": "<base64 of the JSON below>", "sig": "<base64>" }

// payload:
{
  "v": 1,
  "group": "<base64>",   // random group id
  "seq": 1,              // monotonic; consumers refuse lower values
  "admin": "<base64>",   // the admin's Ed25519 public key (pinned at join, TOFU)
  "members": [ { "id": "alice", "sig": "<base64>", "enc": "<base64>", "label": "Alice" } ]
}
```

A verifier checks the signature against the PINNED admin key and that the
embedded `admin` equals it. The single-writer rule for membership is enforced
by construction: only the admin's signature validates.

Implementations SHOULD verify the signed manifest inside the storage layer
itself rather than delegating that call to the application (the TypeScript
library's store takes the SignedManifest plus the pinned admin key and runs
this verification internally on attach and on every membership change) - a
delegated verification is a verification an application can forget.

## 13. Password envelope (format generation 3)

The password envelope is the only password-encrypted shape. A fresh random
32-byte **data key** seals the inner ZIP, and the header carries that data key
wrapped once per key (a **slot**). Any listed key opens the file. A slot is
either **password-derived** (Argon2id over a typed password, the default) or
**external-keyed** (a KEK derived from a caller-supplied high-entropy secret - a
passkey/WebAuthn-PRF output, a hardware token; section 13.7). The two kinds share
one `keys[]` table and one data key, so a passkey for daily use and a recovery
password can coexist on the same backup. Adding or removing a slot rewrites only
the header table - the data is untouched, since the data key does not change.
CHANGING a password is deliberately NOT a slot edit: it is a data-key rotation
(mint a new data key, re-encrypt, single fresh slot), which is what actually
revokes every previously authorized secret. A single password is simply a
one-slot envelope.

**Header authentication (format 3).** The slot table is cleartext, so on its own
a party with WRITE access to the backup could strip or corrupt a slot undetected.
The envelope closes this: the exact `meta.json` bytes are passed as the `data.enc`
GCM additional authenticated data (AAD), binding the whole header - the `keys[]`
table above all - to the ciphertext. Any alteration fails the tag, so the read
returns `DECRYPT_FAILED` rather than silently accepting a tampered slot table.

### 13.1 Container

The encrypted container (section 2): `meta.json`, `data.enc` (AES-256-GCM of
the inner ZIP under the data key, tag appended), a readme.

### 13.2 Header additions

```jsonc
{
  "format": 3,                       // the header rides as the data.enc AAD
  "encryption": "aes-256-gcm",
  "keys": [                          // 1..8 slots; each is password- or external-keyed
    {                                // PASSWORD slot (kind absent, or "password")
      "id": "<string>",              // stable random id; cleartext, cosmetic,
                                     // NOT authenticated (a locator, never a
                                     // security input)
      "kdf": {                       // per-slot Argon2id parameters (section 3)
        "algo": "argon2id",
        "salt": "<base64>", "m": 47104, "t": 3, "p": 1
      },
      "iv": "<base64>",              // 12 random bytes (slot wrap)
      "wrapped": "<base64>"          // AES-256-GCM(KEK, data key), tag appended (48 bytes)
    },
    {                                // EXTERNAL-KEY slot (section 13.7)
      "id": "<string>",              // as above
      "kind": "external",            // discriminant; absent/"password" => password slot
      "keyRef": "<string>",          // opaque, app-owned locator (NOT authenticated)
      "iv": "<base64>",              // 12 random bytes (slot wrap)
      "wrapped": "<base64>"          // AES-256-GCM(KEK, data key), tag appended (48 bytes)
    }
  ],
  "iv": "<base64>"                   // 12 random bytes (data.enc)
}
```

There is no top-level `kdf`: each slot carries its own parameters (and its
own fresh salt), so slots added years apart can use different costs.

### 13.3 Slot cryptography

For each slot the writer derives a key-encryption key from the password with
the slot's own Argon2id parameters and wraps the data key:

```
KEK     = Argon2id(password, slot.kdf)                 // 32 bytes, as section 7
wrapped = AES-256-GCM(KEK, slot.iv, data_key)          // tag appended, 48 bytes
```

The inner ZIP is then sealed under the data key. A writer generates `header.iv`
first, serializes the FULL `meta.json` (so the iv is inside it), and - in
generation 3 - passes those exact bytes as the AAD, binding the whole header to
the ciphertext:

```
data.enc = AES-256-GCM(data_key, header.iv, inner_zip, AAD)
           // AAD = the exact meta.json bytes
```

New writers MUST emit generation 3 (AAD = the meta.json bytes). They MUST use a
fresh random salt and IV per slot, and a fresh random 32-byte data key per
rotation. Writers MUST NOT copy a slot from one data key generation to another
(its wrap would open to a stale key).

### 13.4 Read algorithm (normative, the continuation of section 8 step 3)

1. Parse `meta.json`; require `keys` to be a non-empty array present iff
   `format` is 3 (mode and format id MUST agree, both ways), and known
   `encryption`. Each slot is a password slot (`kind` absent or `"password"`)
   or an external-key slot (`kind": "external"`, section 13.7).
2. Reject more than 8 slots as `UNSUPPORTED_VERSION` BEFORE any derivation:
   each slot is one memory-hard trial, so an unbounded list is a
   denial-of-service by construction.
3. At least one key input is required - a password, or the ability to resolve an
   external slot's secret (else `PASSWORD_REQUIRED`). For each slot, in order:
   a **password** slot needs the password (reject out-of-ceiling KDF parameters,
   section 9, as `UNSUPPORTED_VERSION`; derive the KEK with the slot's Argon2id
   parameters); an **external** slot needs the caller's secret for its `keyRef`
   (derive the KEK by HKDF, section 13.7) and is skipped when none is available.
   Attempt the unwrap. A GCM failure means "not this slot" - continue. An unwrap
   yielding anything other than exactly 32 bytes is likewise "not this slot" (no
   silent AES-128 downgrade).
4. No slot opening is `DECRYPT_FAILED` (a wrong key and a tampered wrap are
   indistinguishable by design).
5. AES-256-GCM-decrypt `data.enc` with the data key and the header `iv`. The
   AAD MUST be the exact `meta.json` bytes as read. A tag failure here is
   `DECRYPT_FAILED` - which is exactly how a stripped or altered header
   surfaces. Read the inner ZIP as in generation 1.

A reader that already holds the data key (e.g. a store re-reading its own
file between syncs) MAY try it directly before any slot work; on a GCM
failure it MUST fall back to the slot path (the file may have been rotated).

### 13.5 Security requirements (additional)

- **Mode binds to generation.** `keys` appears iff `format` is 3; a reader
  MUST reject a mismatch rather than fall to a weaker path (an envelope box
  without `keys`, or a plain box carrying `keys`, is a forgery).
- **Header authentication.** A reader MUST decrypt `data.enc` with the exact
  `meta.json` bytes as AAD, so a tampered header (a stripped or swapped slot,
  an altered `iv`) fails closed as `DECRYPT_FAILED`. A writer MUST emit
  generation 3; a reader MUST refuse any other envelope generation.
- **Bounded slots, bounded KDF.** The slot-count cap (8) and the per-slot KDF
  ceiling (section 9) MUST both hold before deriving anything.
- **Slot ids are cosmetic.** `id` is cleartext and NOT authenticated - like
  `app`, it exists so an application can label and manage slots. A reader
  MUST NOT base any security decision on it.
- **Removal is not revocation.** Whoever once held a password may have kept
  the file (or the data key). Removing a slot stops that password from
  opening FUTURE rewrites of the file; only a data-key rotation (fresh key,
  fresh single slot, re-encrypted data) revokes access to the data going
  forward. Applications MUST present "remove this password" and "change the
  password" with these distinct meanings.
- **All slots are equal.** Every slot opens the same data key; there is no
  owner slot, no permission tiers. An application needing tiered access wants
  group mode (section 12), not slots.

### 13.6 Downgrade resistance

Header authentication (13.5) makes an in-place slot strip fail, and the closed
format set does the rest: a party with WRITE access who re-emits the backup
under an earlier, unauthenticated envelope shape produces a file no conforming
reader opens (section 8 step 2 refuses any format id other than 1, 2 or 3). No
per-destination state is needed. The remaining regression - an encrypted
backup replaced outright by a PLAIN one - is outside the container's reach: a
stateful reader that has seen encryption on a destination SHOULD surface that
regression instead of silently accepting cleartext (the reference library
gates it as `UNEXPECTEDLY_UNENCRYPTED`, leaving local data untouched).

### 13.7 External-key slots

An external-key slot wraps the data key under a KEK derived from a secret the
CALLER supplies, rather than a typed password. It exists so a backup can be
sealed by something other than a password - a passkey/WebAuthn-PRF output, a
hardware token, a platform keychain value - while reusing the same envelope, the
same data key, and the same format-3 header authentication. The format itself
never performs the WebAuthn or hardware dance: the application derives a 32-byte
secret, hands it in, and stores whatever it needs to re-derive it later in the
opaque `keyRef`.

**Shape.** An external slot carries `kind": "external"`, an opaque `keyRef`, an
`iv` and `wrapped` - and NO `kdf` (there is no password to stretch):

```jsonc
{ "id": "<string>", "kind": "external", "keyRef": "<string>",
  "iv": "<base64>", "wrapped": "<base64>" }
```

**KEK derivation.** The secret is already high-entropy, so the KEK is a single
HKDF-SHA256 expansion - NOT Argon2id, whose entire purpose is to stretch
LOW-entropy passwords and which would only add cost with no security gain here:

```
KEK     = HKDF-SHA256(ikm = secret, salt = "" (empty), info = "selfstore-external-slot-v1", L = 32)
wrapped = AES-256-GCM(KEK, slot.iv, data_key)          // tag appended, 48 bytes
```

The fixed `info` string domain-separates this use of the secret from any other.
A writer MUST refuse a secret shorter than 16 bytes (too weak to key a backup);
a passkey PRF output is 32 bytes.

**Read.** An external slot is tried like any other (section 13.4 step 3): the
reader obtains the caller's secret for the slot's `keyRef`, derives the KEK by
HKDF above, and attempts the unwrap; a slot for which no secret is available is
skipped. All slots failing remains `DECRYPT_FAILED`. A reader given only the raw
bytes and a set of candidate secrets can open the file by trying each; the
reference Python reader (section 11) does exactly this with the vector's secret.

**Security requirements (additional to 13.5).**

- **`keyRef` is cosmetic.** Like `id`, it is cleartext and NOT authenticated - a
  locator the application owns (e.g. a WebAuthn credential id), never a security
  input. It rides inside the format-3 AAD, so it cannot be altered silently,
  but a reader MUST NOT base any trust decision on its value.
- **Caller owns the secret's strength.** The envelope assumes a high-entropy
  secret and does no stretching; supplying a low-entropy secret through this path
  (instead of the password path, which applies Argon2id) forfeits the memory-hard
  protection. The 16-byte floor is a guard, not a guarantee of entropy.
- **Same table, same bounds, same authentication.** External slots count toward
  the 8-slot cap, share the one data key, and are bound by the format-3
  header AAD exactly like password slots - stripping or altering an external slot
  fails the tag.

## Appendix A: Argon2id known-answer test

For cross-implementation confidence, Argon2id (v `0x13`) with password = 32 bytes
of `0x01`, salt = 16 bytes of `0x02`, `m = 256`, `t = 3`, `p = 1`, 32-byte output
yields:

```
79b62406841693e13e3ca6a908ca3c20a7ec1a48931461cb54065e63640d1003
```

The reference JS (hash-wasm) and the Python reader (argon2-cffi) both reproduce
this, which is why the Python reader can decrypt JS-written backups.
