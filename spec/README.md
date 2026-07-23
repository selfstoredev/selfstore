# Format spec kit

Everything needed to implement selfstore's backup format independently.

- [`../SPEC.md`](../SPEC.md) - the normative specification (container, header,
  crypto, read algorithm, reader security requirements, group mode, password
  envelope).
- `selfstore_reader.py` - a small reference reader, independent of the
  TypeScript library. Reads the three shapes: plain (format 1), group
  (format 2) and password-envelope (format 3) backups.
- `vectors/` - canonical backups written by the reference library, plus
  `manifest.json` describing their expected decoded content.
- `verify_vectors.py` - asserts the reader's output against the manifest.
- `generate-vectors.mjs` - regenerates `vectors/` from a fresh `npm run build`.
  Run only on a deliberate format change (each run re-timestamps and
  re-randomizes salts/IVs/keys), then review and commit the diff. Filter to
  one vector with an argument (`node spec/generate-vectors.mjs group`) to
  leave the other committed artifacts byte-identical.

## Run the reference reader

```sh
pip install argon2-cffi cryptography
cd spec
python3 selfstore_reader.py vectors/plain.zip
python3 selfstore_reader.py vectors/envelope.zip "second key for the demo"
python3 verify_vectors.py        # asserts all vectors against the manifest
```

The group vector (`group.zip`: Ed25519-signed, sealed per member) verifies in
`verify_vectors.py` with the fixture identities committed in `manifest.json`
(their private keys are TEST FIXTURES, published on purpose like the
password). To read it directly, save one identity to a JSON file and run
`python3 selfstore_reader.py vectors/group.zip identity.json`.

The TypeScript side pins the same vectors in `src/selfstore/vectors.test.ts`, so
a format-breaking change fails CI in both languages at once.
