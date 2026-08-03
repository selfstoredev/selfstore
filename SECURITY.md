# Security policy

## Reporting a vulnerability

Please do NOT open a public issue for a security problem. Report it privately
via GitHub's "Report a vulnerability" (Security tab of this repository), or by
email to florian.mousseau@gmail.com. You will get an acknowledgement within a
few days; a fix and coordinated disclosure follow as fast as severity demands.

## Reviewing the cryptography

Review is welcome and actively wanted: this is a small library whose central
promise is encryption, and its crypto has so far been designed and reviewed by
the same person.

[CRYPTO-RATIONALE.md](CRYPTO-RATIONALE.md) is written for that purpose - every
cryptographic decision with the alternative it rejected and why, and a closing
section naming where its author would attack it first. Start there rather than
in the source: it is the difference between a review that takes an evening and
one that takes a week. [SPEC.md](SPEC.md) is the normative format, and
`spec/verify_vectors.py` runs an independent Python implementation against the
canonical vectors.

An argument that one of those decisions is wrong is worth more than a bug
report, and does not need a working exploit to be worth sending.

## Scope

selfstore's security promises are documented in the README ("Security model"):
AES-256-GCM over an Argon2id-derived key for backups, GCM-authenticated
ciphertext and parameters, cleartext cosmetic header fields that are NOT
authenticated, a zip-bomb guard, at-rest cache sealing under a non-extractable
device key, and a downgrade guard (UNEXPECTEDLY_UNENCRYPTED). Anything that
breaks one of those promises is in scope - including practical attacks below
the stated KDF cost, silent plaintext fallbacks, or authentication bypasses.

Out of scope: attacks requiring code execution in the same origin (an XSS can
read whatever the app can), and the platform's own limits (JavaScript strings
cannot be zeroized).

## Supported versions

Fixes land on the latest published version, and a release carrying one is made
as fast as severity demands rather than on the ordinary release cadence
([RELEASING.md](RELEASING.md)). Older versions are not patched in place:
nothing is ever unpublished, so a burned version number stays installable and
the remedy for a vulnerable one is the next release plus `npm deprecate` on the
old.

The format guarantee is separate and unconditional: a backup written by any
released version stays readable by every later one, so upgrading to take a
security fix never strands a file.
