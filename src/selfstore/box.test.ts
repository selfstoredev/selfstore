import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { writeBox, readBox, readBoxMeta, readBoxWithSync } from './box';
import { mintSlot, mintExternalSlot } from './crypto';
import { gcmSealRaw } from './group';
import { pack } from './archive';
import type { Snapshot } from './types';

function sample(): Snapshot {
	return {
		collections: {
			accounts: [{ id: 'a1', name: 'Livret', value: 4200 }],
			persons: [{ id: 'p1', name: 'Flo' }]
		},
		files: [
			{ id: 'f1', name: 'rib.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3, 4, 5]) }
		]
	};
}

const PK = [0x50, 0x4b, 0x03, 0x04];

describe('box: an unencrypted backup is a browsable ZIP', () => {
	it('is a real ZIP whose entries a user can open', async () => {
		const bytes = await writeBox(sample(), { app: 'test-app' });
		expect([...bytes.subarray(0, 4)]).toEqual(PK);
		const entries = unzipSync(bytes);
		expect(Object.keys(entries).sort()).toEqual(['files/f1', 'meta.json', 'selfstore.json']);
		expect(JSON.parse(strFromU8(entries['meta.json'])).encryption).toBe('none');
		expect(JSON.parse(strFromU8(entries['selfstore.json'])).collections.accounts[0].name).toBe(
			'Livret'
		);
	});

	it('round-trips collections and binary files', async () => {
		const snap = sample();
		const back = await readBox(await writeBox(snap, { app: 'test-app' }));
		expect(back.collections).toEqual(snap.collections);
		expect(back.files[0].bytes).toEqual(snap.files[0].bytes);
	});
});

describe('box: an encrypted backup is a ZIP holding ciphertext + a readme', () => {
	it('opens as a ZIP with a readme, and leaks no cleartext', async () => {
		const bytes = await writeBox(sample(), { app: 'test-app', password: 'hunter2' });
		expect([...bytes.subarray(0, 4)]).toEqual(PK);
		const entries = unzipSync(bytes);
		expect(Object.keys(entries).sort()).toEqual(['LISEZMOI.txt', 'data.enc', 'meta.json']);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		expect(meta.encryption).toBe('aes-256-gcm');
		// Every encrypted write is the authenticated password envelope now (format
		// 3): the KDF parameters live per slot, and the exact meta.json bytes ride
		// as the data.enc GCM AAD so the slot table cannot be stripped or altered.
		expect(meta.format).toBe(3);
		expect(meta.keys).toHaveLength(1);
		expect(meta.keys[0].kdf.algo).toBe('argon2id');
		expect(strFromU8(entries['data.enc'])).not.toContain('Livret');
		expect(strFromU8(entries['LISEZMOI.txt'])).toContain('ZIP');
	});

	it('round-trips with the password and refuses a wrong one', async () => {
		const snap = sample();
		const bytes = await writeBox(snap, { app: 'test-app', password: 'hunter2' });
		expect(await readBoxMeta(bytes)).toMatchObject({ encryption: 'aes-256-gcm' });
		expect((await readBox(bytes, 'hunter2')).collections).toEqual(snap.collections);
		await expect(readBox(bytes)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		await expect(readBox(bytes, 'nope')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});
});

describe('box: the password envelope (format 3, authenticated header)', () => {
	it('a second slot on the same data key: either password opens, a rewrite keeps both', async () => {
		const snap = sample();
		const bytes = await writeBox(snap, { app: 'test-app', password: 'pw-a' });
		const r = await readBoxWithSync(bytes, 'pw-a');
		expect(r.envelope).toBeDefined();
		const { dataKey, slots } = r.envelope!;

		// A writer that knows only one password rewrites through `envelope` and
		// preserves every other slot - nothing is ever re-encrypted for a key change.
		const slotB = await mintSlot('pw-b', dataKey);
		const edited: Snapshot = { ...snap, collections: { accounts: [{ id: 'a2' }] } };
		const rewritten = await writeBox(edited, {
			app: 'test-app',
			envelope: { dataKey, slots: [...slots, slotB] }
		});
		expect((await readBox(rewritten, 'pw-a')).collections.accounts).toEqual([{ id: 'a2' }]);
		expect((await readBox(rewritten, 'pw-b')).collections.accounts).toEqual([{ id: 'a2' }]);
		await expect(readBox(rewritten, 'pw-c')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('a held data key opens with zero KDF work; a stale one falls back cleanly', async () => {
		const snap = sample();
		const bytes = await writeBox(snap, { app: 'test-app', password: 'pw' });
		const r = await readBoxWithSync(bytes, 'pw');

		// The fast path: no password at all, just the captured data key.
		const again = await readBoxWithSync(bytes, undefined, undefined, r.envelope!.dataKey);
		expect(again.snapshot.collections).toEqual(snap.collections);
		expect(again.envelope?.slots).toHaveLength(1);

		// A rotated/foreign key falls through: without a password that is
		// PASSWORD_REQUIRED (not a crash), with the password the slots still open.
		const stale = crypto.getRandomValues(new Uint8Array(32));
		await expect(readBoxWithSync(bytes, undefined, undefined, stale)).rejects.toMatchObject({
			code: 'PASSWORD_REQUIRED'
		});
		const rescued = await readBoxWithSync(bytes, 'pw', undefined, stale);
		expect(rescued.snapshot.collections).toEqual(snap.collections);
	});

	it('refuses crafted envelopes: slot floods, KDF bombs, format/keys disagreement', async () => {
		const bytes = await writeBox(sample(), { app: 'test-app', password: 'pw' });
		const entries = unzipSync(bytes);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		const craft = (m: unknown) => zipSync({ ...entries, 'meta.json': strToU8(JSON.stringify(m)) });

		// More slots than the reader will try (each is one memory-hard trial).
		const flood = {
			...meta,
			keys: Array.from({ length: 9 }, (_, i) => ({ ...meta.keys[0], id: `s${i}` }))
		};
		await expect(readBox(craft(flood), 'pw')).rejects.toMatchObject({
			code: 'UNSUPPORTED_VERSION'
		});

		// A per-slot memory-hard bomb refuses loudly before any derivation.
		const bomb = {
			...meta,
			keys: [{ ...meta.keys[0], kdf: { ...meta.keys[0].kdf, m: 8_000_000 } }]
		};
		await expect(readBox(craft(bomb), 'pw')).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

		// A slot declaring a foreign KDF means a newer writer, not a wrong password.
		const foreign = {
			...meta,
			keys: [{ ...meta.keys[0], kdf: { ...meta.keys[0].kdf, algo: 'scrypt' } }]
		};
		await expect(readBox(craft(foreign), 'pw')).rejects.toMatchObject({
			code: 'UNSUPPORTED_VERSION'
		});

		// format and keys[] must agree both ways: stripping either is a forgery.
		await expect(readBox(craft({ ...meta, keys: undefined }), 'pw')).rejects.toMatchObject({
			code: 'BAD_FORMAT'
		});
		await expect(readBox(craft({ ...meta, format: 1 }), 'pw')).rejects.toMatchObject({
			code: 'BAD_FORMAT'
		});
	});

	it('refuses encrypted content in a plain-format container', async () => {
		// An encrypted payload under a header claiming the plain format (1) was
		// never written by this library. Refuse cleanly: BAD_FORMAT, not a
		// half-read or a crash.
		const old = zipSync({
			'meta.json': strToU8(
				JSON.stringify({
					format: 1,
					app: 'test-app',
					createdAt: '2026-01-01T00:00:00Z',
					encryption: 'aes-256-gcm',
					kdf: { algo: 'argon2id', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', m: 47104, t: 3, p: 1 },
					iv: 'AAAAAAAAAAAAAAAA'
				})
			),
			'data.enc': new Uint8Array([1, 2, 3, 4])
		});
		expect(await readBoxMeta(old)).toMatchObject({ encryption: 'aes-256-gcm', format: 1 });
		await expect(readBox(old, 'old-pw')).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});
});

describe('box: the authenticated header (format 3) is tamper-evident', () => {
	it('detects a stripped key slot - the exact move a write-capable party would make', async () => {
		// Two passwords on one data key: the cleartext header lists both slots.
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slots = [await mintSlot('alice', dataKey), await mintSlot('bob', dataKey)];
		const bytes = await writeBox(sample(), { app: 'test-app', envelope: { dataKey, slots } });
		expect(await readBoxMeta(bytes)).toMatchObject({ format: 3 });
		expect((await readBox(bytes, 'alice')).collections).toEqual(sample().collections);
		expect((await readBox(bytes, 'bob')).collections).toEqual(sample().collections);

		// A party with write access to the blob strips bob's slot from the header.
		const entries = unzipSync(bytes);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		meta.keys = [meta.keys[0]]; // drop bob's slot
		const tampered = zipSync({ ...entries, 'meta.json': strToU8(JSON.stringify(meta)) });

		// The header rode as the data.enc GCM AAD, so alice's still-valid slot no
		// longer opens the file: the strip is DETECTED (fail closed), not accepted.
		await expect(readBox(tampered, 'alice')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('detects any header field alteration, down to a cosmetic one', async () => {
		const bytes = await writeBox(sample(), { app: 'test-app', password: 'pw' });
		const entries = unzipSync(bytes);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		meta.createdAt = '1999-01-01T00:00:00.000Z'; // even this is inside the AAD now
		const tampered = zipSync({ ...entries, 'meta.json': strToU8(JSON.stringify(meta)) });
		await expect(readBox(tampered, 'pw')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('refuses an envelope under an unsupported format id', async () => {
		// Hand-build an envelope-shaped file (keys[] + a data.enc sealed with no
		// AAD) under a format id the reader does not accept. Only 1/2/3 open, so
		// an attacker cannot smuggle an alternate, unauthenticated envelope
		// generation - even with a slot the password would open.
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slots = [await mintSlot('pw', dataKey)];
		const enc = await gcmSealRaw(dataKey, await pack(sample()));
		const meta = {
			format: 4,
			app: 'test-app',
			createdAt: '2026-01-01T00:00:00.000Z',
			encryption: 'aes-256-gcm',
			keys: slots,
			iv: enc.iv
		};
		const zip = zipSync({
			'meta.json': strToU8(JSON.stringify(meta)),
			'data.enc': enc.ciphertext,
			'LISEZMOI.txt': strToU8('x')
		});
		// Even inspecting it is refused: format 4 is past the newest id (3).
		await expect(readBoxMeta(zip)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
		await expect(readBoxWithSync(zip, 'pw')).rejects.toMatchObject({
			code: 'UNSUPPORTED_VERSION'
		});
	});
});

describe('box: external-key slots (a caller-supplied secret, no password)', () => {
	it('round-trips a backup sealed by an external secret', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintExternalSlot(secret, 'passkey:cred-1', dataKey);
		const bytes = await writeBox(sample(), {
			app: 'test-app',
			envelope: { dataKey, slots: [slot] }
		});

		// The authenticated envelope like any other encrypted write - no password.
		expect(await readBoxMeta(bytes)).toMatchObject({ format: 3, encryption: 'aes-256-gcm' });
		const r = await readBoxWithSync(bytes, undefined, undefined, undefined, async (s) => {
			// The reader hands the app the exact slot, so it can pick the right secret.
			expect(s.kind).toBe('external');
			expect(s.keyRef).toBe('passkey:cred-1');
			return secret;
		});
		expect(r.snapshot.collections).toEqual(sample().collections);
		expect(r.format).toBe(3);
	});

	it('lets a password and an external key coexist on one backup', async () => {
		// The intended pairing: a passkey for daily use plus a recovery password,
		// one data key, two slots - either one opens the file.
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slots = [
			await mintExternalSlot(secret, 'passkey:cred-1', dataKey),
			await mintSlot('recovery-pw', dataKey)
		];
		const bytes = await writeBox(sample(), { app: 'test-app', envelope: { dataKey, slots } });

		// The password alone opens it (external slot skipped: no resolver).
		expect((await readBox(bytes, 'recovery-pw')).collections).toEqual(sample().collections);
		// The secret alone opens it (password slot skipped: no password).
		const r = await readBoxWithSync(bytes, undefined, undefined, undefined, async () => secret);
		expect(r.snapshot.collections).toEqual(sample().collections);
	});

	it('fails closed when the resolver yields the wrong secret', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintExternalSlot(secret, 'passkey:cred-1', dataKey);
		const bytes = await writeBox(sample(), {
			app: 'test-app',
			envelope: { dataKey, slots: [slot] }
		});

		const wrong = crypto.getRandomValues(new Uint8Array(32));
		await expect(
			readBoxWithSync(bytes, undefined, undefined, undefined, async () => wrong)
		).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('asks for a key when neither a password nor a resolver is given', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintExternalSlot(secret, 'passkey:cred-1', dataKey);
		const bytes = await writeBox(sample(), {
			app: 'test-app',
			envelope: { dataKey, slots: [slot] }
		});

		await expect(readBoxWithSync(bytes)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
	});

	it('binds the external slot under the format-3 header: stripping a slot is detected', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slots = [
			await mintExternalSlot(secret, 'passkey:cred-1', dataKey),
			await mintSlot('recovery-pw', dataKey)
		];
		const bytes = await writeBox(sample(), { app: 'test-app', envelope: { dataKey, slots } });

		// A write-capable party strips the recovery password slot from the header.
		const entries = unzipSync(bytes);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		meta.keys = [meta.keys[0]];
		const tampered = zipSync({ ...entries, 'meta.json': strToU8(JSON.stringify(meta)) });

		// The header rode as the data.enc AAD, so even the surviving external secret
		// no longer opens the altered file: the strip is DETECTED, not accepted.
		await expect(
			readBoxWithSync(tampered, undefined, undefined, undefined, async () => secret)
		).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('reads an external-keyed backup from the held data key alone (no resolver)', async () => {
		// The store re-reading its own file between syncs already holds the data key,
		// so no passkey gesture is needed for a background converge.
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintExternalSlot(secret, 'passkey:cred-1', dataKey);
		const bytes = await writeBox(sample(), {
			app: 'test-app',
			envelope: { dataKey, slots: [slot] }
		});

		const r = await readBoxWithSync(bytes, undefined, undefined, dataKey);
		expect(r.snapshot.collections).toEqual(sample().collections);
		expect(r.envelope?.slots).toHaveLength(1);
	});
});

describe('box: bad input', () => {
	it('rejects bytes that are not a ZIP', async () => {
		await expect(readBoxMeta(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toMatchObject({
			code: 'BAD_FORMAT'
		});
	});
});
