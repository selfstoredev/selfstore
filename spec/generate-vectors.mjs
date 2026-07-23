/**
 * Regenerate the canonical test vectors in spec/vectors/ from the built library.
 * Run deliberately (node spec/generate-vectors.mjs) after an intended format
 * change - the committed vectors are fixed artifacts an independent reader tests
 * against, so they are NOT regenerated in CI (each carries a fresh timestamp and,
 * when encrypted, a random salt/IV).
 *
 * Requires a build first: npm run build.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportSnapshot, createLocalStore, memoryCache } from '../dist/advanced.js';
import { generateIdentity } from '../dist/groups.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'vectors');
mkdirSync(out, { recursive: true });

// Optional filter: `node generate-vectors.mjs group` regenerates only vectors
// whose name starts with "group" (and refreshes the manifest), leaving the
// other committed artifacts byte-identical.
const only = process.argv[2];
const wanted = (name) => !only || name.startsWith(only);

const enc = new TextEncoder();
const PASSWORD = 'correct horse battery staple';
const SECOND_PASSWORD = 'second key for the demo';
// A FIXED external secret, committed like the passwords, so an independent reader
// reproduces the external-slot open forever. It stands in for a passkey /
// WebAuthn-PRF output (32 bytes), which selfstore never derives itself.
const EXTERNAL_SECRET = new Uint8Array(32).fill(0x2a);
const EXTERNAL_KEYREF = 'passkey-demo';

// A fixed snapshot: two records with string ids, plus one binary file.
const snapshot = {
	collections: {
		notes: [
			{ id: 'n1', text: 'hello world' },
			{ id: 'n2', text: 'deuxieme note' }
		]
	},
	files: [{ id: 'f1', name: 'a.txt', mime: 'text/plain', bytes: enc.encode('file bytes 123') }]
};

const meta = { app: 'spec-demo', appVersion: '1.0.0', schemaVersion: 1 };

async function write(name, blob) {
	if (!wanted(name)) return;
	writeFileSync(join(out, name), Buffer.from(await blob.arrayBuffer()));
}

// 1. Plain (browsable): meta.json + selfstore.json + files/*
await write('plain.zip', await exportSnapshot(snapshot, meta));

// 2. Store-written: same, plus the opaque sync.json bookkeeping entry.
const app = { collections: structuredClone(snapshot.collections) };
const store = createLocalStore({
	app: 'spec-demo',
	schemaVersion: 1,
	gather: () => ({ collections: structuredClone(app.collections), files: snapshot.files }),
	apply: (s) => {
		app.collections = structuredClone(s.collections ?? {});
	},
	cache: memoryCache()
});
await store.init();
await write('store.zip', await store.exportBlob());

// 3b. Authenticated password envelope (format 3), through the PUBLIC store
// surface exactly as a real app grows a second key: setEncryption mints the
// envelope, addEncryptionKey wraps the same data key under another password. The
// saved target bytes ARE the vector (sync.json rides inside the sealed inner ZIP;
// the exact meta.json bytes ride as the data.enc GCM AAD, so the slot table is
// tamper-evident).
if (wanted('envelope.zip')) {
	let remote = null;
	const target = {
		kind: 'file',
		label: 'vector.zip',
		async save(b) {
			remote = b;
			return null;
		},
		async load() {
			return remote;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {}
	};
	const app5 = { collections: structuredClone(snapshot.collections) };
	const store5 = createLocalStore({
		app: 'spec-demo',
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app5.collections), files: snapshot.files }),
		apply: (s) => {
			app5.collections = structuredClone(s.collections ?? {});
		},
		cache: memoryCache()
	});
	await store5.init();
	await store5.attachTarget(target, { strategy: 'replace-remote' });
	await store5.setEncryption(PASSWORD);
	await store5.addEncryptionKey(SECOND_PASSWORD, 'second');
	await write('envelope.zip', remote);
	store5.dispose();
}

// 3c. Envelope with BOTH a password slot AND an external-key slot (format 3):
// setEncryption mints the password slot, addExternalKey wraps the SAME data key
// under an HKDF-SHA256 KEK derived from a caller-supplied secret (SPEC 13.7).
// Proves the two slot kinds coexist and that EITHER opens the file. The secret is
// a fixed committed fixture (see the manifest's per-file `external`).
if (wanted('envelope-external.zip')) {
	let remote = null;
	const target = {
		kind: 'file',
		label: 'vector.zip',
		async save(b) {
			remote = b;
			return null;
		},
		async load() {
			return remote;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {}
	};
	const appX = { collections: structuredClone(snapshot.collections) };
	const storeX = createLocalStore({
		app: 'spec-demo',
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(appX.collections), files: snapshot.files }),
		apply: (s) => {
			appX.collections = structuredClone(s.collections ?? {});
		},
		cache: memoryCache()
	});
	await storeX.init();
	await storeX.attachTarget(target, { strategy: 'replace-remote' });
	await storeX.setEncryption(PASSWORD);
	await storeX.addExternalKey(EXTERNAL_SECRET, EXTERNAL_KEYREF, 'passkey');
	await write('envelope-external.zip', remote);
	storeX.dispose();
}

// 4. Group (format 2): signed by alice, sealed for alice + bob. The identities
// are TEST FIXTURES (private keys committed on purpose, like the password) so
// an independent reader can decrypt and verify the exact same bytes forever.
// Regenerating replaces them together with the file; on a filtered run the
// previous identities are reused from the committed manifest.
let groupIdentities;
if (wanted('group.zip')) {
	groupIdentities = { alice: await generateIdentity(), bob: await generateIdentity() };
	await write(
		'group.zip',
		await exportSnapshot(snapshot, {
			...meta,
			group: {
				recipients: [groupIdentities.alice.encPub, groupIdentities.bob.encPub],
				sign: { pub: groupIdentities.alice.sigPub, priv: groupIdentities.alice.sigPriv }
			}
		})
	);
} else {
	groupIdentities = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).group.identities;
}

// The expected decoded content, for a reader to assert against.
const manifest = {
	password: PASSWORD,
	app: meta.app,
	appVersion: meta.appVersion,
	schemaVersion: meta.schemaVersion,
	expected: {
		collections: snapshot.collections,
		files: [{ id: 'f1', name: 'a.txt', mime: 'text/plain', text: 'file bytes 123' }]
	},
	files: {
		'plain.zip': { encryption: 'none', hasSyncJson: false },
		'store.zip': { encryption: 'none', hasSyncJson: true },
		'group.zip': { encryption: 'aes-256-gcm', keying: 'x25519-hkdf-sha256', hasSyncJson: false },
		// Format 5: the exact meta.json bytes ride as the data.enc GCM AAD so
		// the slot table cannot be stripped or altered.
		'envelope.zip': {
			encryption: 'aes-256-gcm',
			format: 3,
			hasSyncJson: true,
			passwords: [PASSWORD, SECOND_PASSWORD]
		},
		// A password slot AND an external-key slot on one data key (SPEC 13.7):
		// the password opens it, and so does the fixed external secret below.
		'envelope-external.zip': {
			encryption: 'aes-256-gcm',
			format: 3,
			hasSyncJson: true,
			passwords: [PASSWORD],
			external: {
				secretB64: Buffer.from(EXTERNAL_SECRET).toString('base64'),
				keyRef: EXTERNAL_KEYREF
			}
		}
	},
	group: {
		author: 'alice',
		identities: groupIdentities
	}
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('wrote vectors to', out);
