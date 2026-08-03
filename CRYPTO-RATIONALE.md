# Cryptographic design rationale

This document exists to be **attacked**.

[SPEC.md](SPEC.md) says what the bytes are. [THREAT-MODEL.md](THREAT-MODEL.md)
says what we are defending against. Neither says *why each cryptographic
decision was made*, and without that a reviewer has to reconstruct intent from
implementation - which nobody does for free, and which makes "it looks fine"
the only affordable review.

So: every choice below is stated with the alternative that was rejected and the
reason. Where a decision is a genuine trade rather than a clear win, it says
so. The last section lists where I would attack this first if I wanted to break
it; that list is honest, not defensive.

Corrections, disagreements and attacks: see [SECURITY.md](SECURITY.md). A
finding that changes one of these decisions is more valuable than a bug report.

---

## 0. What the cryptography is protecting

One sentence, because every decision below is downstream of it:

> An ordinary person's application data, at rest on storage they do not
> control, against an adversary who has the file but was never in their
> browser.

Not: a newsroom against a state. Not: a service protecting many tenants from
each other. The gap between those threat models is why several decisions here
would be wrong in a different product, and saying which product this is
prevents a reviewer from measuring against the wrong bar.

The full asset list, trust boundaries and non-goals are in
[THREAT-MODEL.md](THREAT-MODEL.md).

---

## 1. AES-256-GCM for the payload

**Chosen** because it is the authenticated cipher WebCrypto implements
natively, in every target browser, hardware-accelerated, with no library to
ship, review or keep patched.

That last clause is the whole argument. The alternative is not "a better
cipher" in the abstract - it is *a better cipher plus several thousand lines of
JavaScript or WASM that a reviewer must also audit, that adds to a bundle this
library keeps deliberately small, and that ships with the same author's
review-of-one problem as everything else here*. WebCrypto's AES-GCM has been
audited by people this project will never be able to hire.

**Rejected: XChaCha20-Poly1305.** Better nonce story (192-bit nonces make
random-nonce collision a non-question, see §6). Not in WebCrypto, so it costs a
dependency. The nonce problem it solves is quantified in §6 and does not
justify the cost here.

**Rejected: AES-GCM-SIV / AES-SIV.** Misuse-resistant, which is genuinely
attractive given §6. Not in WebCrypto either, same cost, and the misuse it
resists (nonce reuse from a counter that resets) is not the failure mode here -
nonces are random, never counted.

**Accepted consequence: GCM is not key-committing.** A ciphertext can in
principle be crafted to decrypt successfully under two different keys. This
matters when an adversary supplies the ciphertext AND the victim tries several
keys - which is close to the multi-slot open path in §3. Why it is judged
acceptable there, and why it is still on the attack list, is in §3 and §10.

---

## 2. Argon2id for the password, with the parameters in the file

**Chosen** because the input is a human-chosen passphrase, which is
low-entropy, and memory-hardness is the only thing that meaningfully raises the
cost of guessing it on a GPU.

**Parameters: m = 46 MiB, t = 3, p = 1.** OWASP's Password Storage Cheat Sheet
gives 46 MiB / t = 1 / p = 1 as a recommended configuration; this triples the
passes at the same memory, costing roughly 1-2 s on a phone. Deliberately
conservative: a backup is decrypted rarely - once per session at most - so
spending a second there is invisible to a user and multiplies an attacker's
per-guess cost.

**Parameters travel in the file, in the clear.** Every backup carries the salt
and its own m/t/p. The alternative - a constant in the code - means that
raising the default breaks every file written before, which contradicts the one
promise the format actually makes ("a backup written by any version stays
readable"). The cost is that the parameters are attacker-visible; they are not
secret in any threat model, since an attacker who has the file will simply try
the defaults anyway.

**They are also bounded on read** (`assertKdfBounds`: m ≤ 1 GiB, t ≤ 10,
p ≤ 4). Without a ceiling, a crafted file declaring m = 8 GiB is a
denial-of-service against the reader before any password is checked. Out-of-
range parameters raise `UNSUPPORTED_VERSION`, never `DECRYPT_FAILED` - the file
is not corrupt, its parameters are outside what this reader will run, and
saying so is the difference between a user retyping their password forever and
a user reading an accurate message.

**Rejected: scrypt.** Comparable, older, and not in WebCrypto either, so it
carries the same dependency cost with less current guidance behind it.

**Rejected: PBKDF2**, which *is* in WebCrypto and would have removed the
`hash-wasm` dependency entirely. It is not memory-hard: GPU and ASIC attackers
get orders of magnitude more guesses per second for the same money. This is the
one place where the "use only what WebCrypto ships" principle was overridden,
and the dependency it costs is one of the library's three.

**The derivation runs in a Worker** (shipped as `selfstore/kdf-worker`), with a
main-thread fallback that produces byte-identical output. Nothing
security-relevant rides on which one ran; the split exists so a phone does not
freeze for two seconds.

---

## 3. The key envelope: one data key, several ways in

Generation 3 encrypts the payload once under a **random 32-byte data key**, and
wraps that key once per secret that should open the file (`keys[]`, up to
`MAX_KEY_SLOTS = 8`).

**Why not encrypt directly under the password-derived key?** Because then a
second password means a second copy of the whole payload, changing a password
means re-encrypting everything, and a printed recovery code is impossible.
Indirection through a data key is what makes "my spouse's password also opens
this" and "rotate the password without rewriting the backup" both one operation.

**The AAD binds the header to the payload.** The exact `meta.json` bytes are
passed as the GCM additional authenticated data for `data.enc`. This is the
decision that makes the slot table tamper-evident: someone with write access to
the file cannot strip a slot, add one, or swap the table without breaking the
tag. Without it, an attacker who could write to the destination could remove
the owner's slot and leave only theirs.

**Bounded slots.** Each slot costs one Argon2id trial on open, so an unbounded
`keys[]` is a memory-hard bomb dressed as a feature. Eight is arbitrary but
finite, which is the property that matters.

**Fail-closed, with one deliberate exception.** `openSlot` returns `null` for a
wrong password *and* for tampered bytes - GCM cannot tell them apart and
neither should the caller, so `DECRYPT_FAILED` means "wrong password or
corrupted file" and nothing narrower. The exception: a bounds violation is
re-thrown rather than swallowed, so a memory-hard bomb cannot disguise itself
as an ordinary wrong password.

**Unwrap sanity check.** An opened slot is accepted only if it yields exactly
32 bytes. This is weak - it is a length check, not key commitment - but it is
free, and it turns the most likely form of the §1 non-committing-GCM concern
(a crafted slot that "opens" to garbage) into a rejection rather than an
attempt to decrypt the payload with nonsense.

---

## 4. External-key slots: HKDF, not Argon2

A slot may be keyed by a secret the platform provides rather than a password -
a passkey PRF output, a hardware token. These use **one HKDF-SHA256 expansion**
where password slots use Argon2id.

**Why the difference.** Argon2 exists to make guessing a low-entropy secret
expensive. A passkey PRF output is 32 uniformly random bytes: there is nothing
to guess, and spending 46 MiB and a second to stretch it buys precisely
nothing. Using a memory-hard KDF where it is not needed is not "extra safe", it
is a cost with no defensive story, and the sort of thing that suggests the
author is applying a ritual rather than a reason.

**Domain separation is explicit.** The HKDF `info` is the fixed label
`selfstore-external-slot-v1`. If the same authenticator secret is ever used for
another purpose - by this library or by the host application - the derived keys
do not collide. The version suffix exists so that changing the derivation later
is a new label rather than a silent reinterpretation of old files.

**A 16-byte floor** on the secret, because anything shorter is not the
high-entropy input this path assumes, and silently accepting it would turn the
absence of Argon2 from a reasoned choice into a vulnerability.

---

## 5. Group mode: the age recipient model

A group copy is encrypted once under a fresh data key, and that key is
enveloped per member using ephemeral X25519 ECDH → HKDF-SHA256 → AES-GCM wrap.
Each member holds an Ed25519 signing keypair and an X25519 receiving keypair.
Membership is a manifest signed by one admin key, pinned by members on first
use.

**Why this shape.** It is the recipient model `age` uses, for the same reason:
it is the smallest construction that gives "encrypt once, address to N people",
it is well understood, and every primitive is in WebCrypto - no curve
implementation to ship or review.

**Signatures cover the exact bytes, not re-serialized JSON.** The signed
payload is stored and verified as the byte string that was signed. This
sidesteps JSON canonicalization entirely, which is a recurring source of
signature-bypass bugs in systems that re-serialize before verifying: two
serializers that disagree about key order or number formatting produce a
document that verifies as something other than what it says.

**Domain separation per role**, on the same reasoning as §4: bytes signed as a
manifest can never be replayed as bytes signed in another role.

**Admin key is trust-on-first-use.** There is no PKI here, and TOFU is the
honest description: a member who is handed the wrong admin key at join time
joins the wrong group. The alternative - a verification step out of band -
exists in the docs as a recommendation, not as an enforced mechanism.

**Refused rather than degraded.** Group mode requires WebCrypto Ed25519 and
X25519; where they are absent the library says so, with a clear error, instead
of falling back to a JavaScript implementation. A silent fallback to unreviewed
curve code is worse than an unavailable feature.

**Named non-goal: no forward secrecy, no post-compromise security.** Member
keys are long-lived. A member who is removed, and who kept a copy of the file
and their key, can still read that copy; a compromised key stays useful to an
attacker across later copies. This is the property that continuous group key
agreement protocols provide - MLS (RFC 9420), and for this exact setting
(no central server, causal order only) Ink & Switch's
[BeeKEM / Keyhive](https://www.inkandswitch.com/keyhive/notebook/). Adopting
one is the known remedy and is not implemented. Removal here means "future
copies are not addressed to you", not "your access is revoked".

---

## 6. Nonces, and the honest arithmetic

Every GCM operation uses a **fresh 96-bit nonce from `crypto.getRandomValues`**
- never a counter, never derived, never reused deliberately.

The residual question a reviewer should ask: the data key is stable across
saves (that is the point of §3), and each save draws a random 96-bit nonce, so
what is the collision risk? With random 96-bit nonces the birthday bound puts
the probability of any collision after *n* encryptions under one key at roughly
n² / 2^97. At a billion saves under one unchanged password - far beyond what a
personal backup will ever see - that is around 2^-37.

Stated rather than assumed, because "random nonce with a long-lived key" is
exactly the pattern that has broken other systems, and a reviewer is right to
check it. It is safe here because *n* is bounded by human behaviour, not by a
protocol running at line rate. It would not be safe in a system encrypting
continuously, which is one reason §1 rejects the alternative on cost rather
than on merit.

---

## 7. The local cache: encrypted, and honestly scoped

The IndexedDB working copy is sealed with AES-256-GCM under a **non-extractable
device key** (`generateKey(..., extractable = false)`), fresh IV per record.
Only small sync bookkeeping stays in the clear.

**What this defends against**: casual inspection, partial exfiltration, disk
forensics of the store.

**What it explicitly does not**: code running in the origin (an XSS reads
whatever the app reads), and a copy of the whole browser profile - the key
lives in that profile, non-extractable to JavaScript but not to whoever has the
disk. Claiming otherwise would be the most tempting lie in this document.

**`cacheLock` is the answer to that second case**: the cache key is derived
from a secret held only in memory (a password, a passkey PRF result) and never
written to disk, so a full profile copy is unreadable. It is still bounded by
the origin - once unlocked, code in the page decrypts. The trade is a prompt
per session and a **forgotten secret being unrecoverable by design**, which is
why `clear()` needs no key: an unrecoverable cache must still be abandonable,
or the feature is a trap.

**Decrypt failure propagates rather than returning "no data".** A cache read
that fails must never look like an empty cache, because the caller's next move
would be to write over ciphertext that a different key could still have opened.

---

## 8. What the header says before you have a key

The cleartext header (`app`, `appVersion`, `createdAt`, and the mode fields) is
readable without any secret. That is deliberate: `restore(file).meta()` lets an
application say "this backup is from another app" without asking for a
password first, which is a real usability win at no confidentiality cost - the
data itself is the secret, not the name of the program that wrote it.

The precise authentication status is worth stating exactly, because the short
version in the README is coarser than the truth:

- **Generation 3**: the entire `meta.json` is the payload's AAD, so every
  header field, cosmetic ones included, is authenticated - **for a reader who
  holds the key**.
- **Generation 2**: the header is covered by the author's signature.
- **Generation 1**: nothing is encrypted, so there is nothing to authenticate.

The rule for applications is therefore not "the header is unauthenticated" but
the sharper: **the header is not trustworthy at the moment you are tempted to
use it**, which is before decryption. Show it to a human; never branch a
security decision on it.

---

## 9. Things deliberately not done

- **No custom cipher, mode, or construction.** Everything here is a standard
  primitive composed in a standard way. Novel cryptography in a library with
  one author is the failure mode this whole document exists to avoid.
- **No "encrypt the whole IndexedDB and call it end-to-end".** Local plaintext
  is a considered choice: it keeps queries and DevTools usable, and the
  boundary that matters is the device edge, not the database edge.
- **No password zeroization theatre.** JavaScript strings cannot be wiped; the
  platform offers no way. Derived keys are non-extractable `CryptoKey`s, which
  is the part that can actually be constrained. Pretending otherwise would
  misrepresent the platform.
- **No compression before encryption... except that there is.** The payload is
  a ZIP, so the plaintext is compressed and its ciphertext length leaks
  something about content compressibility. For a backup of an application's own
  data, with no attacker-chosen plaintext mixed in, the CRIME/BREACH class of
  attack does not apply. It would if an application stored attacker-supplied
  content next to a secret in the same archive, which is worth knowing before
  building that.

---

## 10. Where I would attack this first

In the order I would actually try them:

1. **The multi-slot open path against non-committing GCM** (§1, §3). Eight
   slots, each tried in turn, on a file an attacker may have supplied. The
   32-byte length check is the only thing between a crafted slot and the
   payload decrypt. I believe the impact is bounded - the payload's own tag
   still has to verify - but "I believe" is exactly the phrase that should
   attract a reviewer.
2. **Group membership before the manifest is trusted.** TOFU on the admin key
   means the entire group's integrity rests on one out-of-band step that the
   library recommends and cannot enforce. What happens to a member who is
   handed a manifest signed by an admin key they never verified is the
   interesting question.
3. **Header parsing before authentication.** Everything in `meta.json` is
   parsed - and used to route, size and bound - before any tag is checked. The
   bounds guards exist for exactly this, and the question is whether they are
   complete: every field that reaches an allocation or a loop count before
   decryption is a candidate.
4. **The downgrade boundary.** A reader accepting a plaintext backup where an
   encrypted one was expected is the highest-value single bug in the system.
   `UNEXPECTEDLY_UNENCRYPTED` and `requireEncryption` exist to close it; the
   question is whether every path that loads data passes through them.
5. **Nonce sourcing under a degraded platform.** All of §6 assumes
   `crypto.getRandomValues` is sound. A platform where it is not is out of the
   threat model, but the failure would be silent and total, and it is worth
   knowing whether anything would notice.

If you find something, [SECURITY.md](SECURITY.md) has the private channel.
Findings that change a decision in this document will be credited here.
