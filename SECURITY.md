# Security policy

## Reporting a vulnerability

Please do NOT open a public issue for a security problem. Report it privately
via GitHub's "Report a vulnerability" (Security tab of this repository), or by
email to florian.mousseau@gmail.com. You will get an acknowledgement within a
few days; a fix and coordinated disclosure follow as fast as severity demands.

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

Pre-1.0, only the latest published minor receives fixes.
