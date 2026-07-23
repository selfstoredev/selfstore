/**
 * Passwordless groups, format layer: identity + envelope roundtrips, the
 * signed manifest, and the group box (format generation 2) with its trust
 * order - signature and author membership before any decryption, envelope
 * (NOT_A_RECIPIENT) after, tampering refused everywhere.
 */

import { describe, it, expect } from 'vitest';
import {
	groupCryptoAvailable,
	generateIdentity,
	sealDataKey,
	openDataKey,
	signManifest,
	openManifest,
	newGroupId,
	keyId,
	type GroupManifest
} from './group';
import { writeBox, readBoxWithSync } from './box';
import { inspect } from './index';
import type { Snapshot } from './types';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const snapshot: Snapshot = {
	collections: { notes: [{ id: 'n1', text: 'tres secret' }] },
	files: []
};
const meta = { app: 'group-demo', schemaVersion: 1 };

const rezip = (bytes: Uint8Array, mutate: (e: Record<string, Uint8Array>) => void): Uint8Array => {
	const entries = unzipSync(bytes);
	mutate(entries);
	return zipSync(entries, { level: 0 });
};

describe('platform', () => {
	it('WebCrypto provides Ed25519 + X25519 here (Node 20+)', async () => {
		expect(await groupCryptoAvailable()).toBe(true);
	});
});

describe('data-key envelopes', () => {
	it('every recipient opens the same key; an outsider gets NOT_A_RECIPIENT', async () => {
		const [a, b, c, outsider] = await Promise.all([
			generateIdentity(),
			generateIdentity(),
			generateIdentity(),
			generateIdentity()
		]);
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const stanzas = await sealDataKey(dataKey, [a.encPub, b.encPub, c.encPub]);
		expect(stanzas).toHaveLength(3);
		expect(stanzas[0].kid).toBe(await keyId(a.encPub));

		for (const who of [a, b, c]) {
			expect(await openDataKey(stanzas, who)).toEqual(dataKey);
		}
		await expect(openDataKey(stanzas, outsider)).rejects.toMatchObject({
			code: 'NOT_A_RECIPIENT'
		});
	});
});

describe('signed membership manifest', () => {
	it('signs, verifies against the pinned admin key, and refuses everything else', async () => {
		const admin = await generateIdentity();
		const impostor = await generateIdentity();
		const manifest: GroupManifest = {
			v: 1,
			group: newGroupId(),
			seq: 1,
			admin: admin.sigPub,
			members: [{ id: 'admin', sig: admin.sigPub, enc: admin.encPub }]
		};
		const signed = await signManifest(manifest, admin.sigPriv);

		expect(await openManifest(signed, admin.sigPub)).toEqual(manifest);

		// The wrong pinned key: refused even though the signature is internally valid.
		await expect(openManifest(signed, impostor.sigPub)).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});

		// A tampered payload (member list edited after signing): refused.
		const doctored = {
			...signed,
			payload: Buffer.from(
				JSON.stringify({
					...manifest,
					members: [{ id: 'evil', sig: impostor.sigPub, enc: impostor.encPub }]
				})
			).toString('base64')
		};
		await expect(openManifest(doctored, admin.sigPub)).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});
	});
});

describe('group box (format generation 2)', () => {
	async function writeGroupBox() {
		const alice = await generateIdentity();
		const bob = await generateIdentity();
		const bytes = await writeBox(
			snapshot,
			{
				...meta,
				group: {
					recipients: [alice.encPub, bob.encPub],
					sign: { pub: alice.sigPub, priv: alice.sigPriv }
				}
			},
			{ schemaVersion: 1, meta: { marker: 'sidecar' } }
		);
		return { alice, bob, bytes };
	}

	it('roundtrips for every recipient and reports the verified author', async () => {
		const { alice, bob, bytes } = await writeGroupBox();
		for (const who of [alice, bob]) {
			const r = await readBoxWithSync(bytes, undefined, {
				identity: who,
				authors: [alice.sigPub]
			});
			expect(r.snapshot.collections).toEqual(snapshot.collections);
			expect((r.sidecar as { meta: { marker: string } }).meta.marker).toBe('sidecar');
			expect(r.author).toBe(alice.sigPub);
		}
	});

	it('is a real ZIP whose header says group mode, and leaks no plaintext', async () => {
		const { alice, bytes } = await writeGroupBox();
		const header = await inspect(bytes);
		expect(header.format).toBe(2);
		expect(header.encryption).toBe('aes-256-gcm');
		expect(header.keying).toBe('x25519-hkdf-sha256');
		expect(header.author).toBe(alice.sigPub);
		expect(new TextDecoder().decode(bytes)).not.toContain('tres secret');
	});

	it('refuses to open without an identity (IDENTITY_REQUIRED)', async () => {
		const { bytes } = await writeGroupBox();
		await expect(readBoxWithSync(bytes)).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
	});

	it('an outsider identity is NOT_A_RECIPIENT; an untrusted author is SIGNATURE_INVALID', async () => {
		const { alice, bytes } = await writeGroupBox();
		const outsider = await generateIdentity();
		await expect(
			readBoxWithSync(bytes, undefined, { identity: outsider, authors: [alice.sigPub] })
		).rejects.toMatchObject({ code: 'NOT_A_RECIPIENT' });

		// The reader trusts only `outsider` as an author: alice's copy is refused
		// before any crypto (membership comes first).
		await expect(
			readBoxWithSync(bytes, undefined, { identity: alice, authors: [outsider.sigPub] })
		).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
	});

	it('tampering with the ciphertext or the header breaks the signature', async () => {
		const { alice, bytes } = await writeGroupBox();
		const read = (b: Uint8Array) =>
			readBoxWithSync(b, undefined, { identity: alice, authors: [alice.sigPub] });

		const flippedData = rezip(bytes, (e) => {
			e['data.enc'][8] ^= 0xff;
		});
		await expect(read(flippedData)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });

		// Rewriting the author claim (impersonation) breaks the signature too:
		// the signature covers the exact meta.json bytes.
		const outsider = await generateIdentity();
		const swappedAuthor = rezip(bytes, (e) => {
			const m = JSON.parse(strFromU8(e['meta.json'])) as { author: string };
			m.author = outsider.sigPub;
			e['meta.json'] = strToU8(JSON.stringify(m));
		});
		await expect(
			readBoxWithSync(swappedAuthor, undefined, {
				identity: alice,
				authors: [alice.sigPub, outsider.sigPub]
			})
		).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
	});

	it('refuses a future keying or format as UNSUPPORTED_VERSION', async () => {
		const { alice, bytes } = await writeGroupBox();
		const read = (b: Uint8Array) =>
			readBoxWithSync(b, undefined, { identity: alice, authors: [alice.sigPub] });

		const futureKeying = rezip(bytes, (e) => {
			const m = JSON.parse(strFromU8(e['meta.json'])) as { keying: string };
			m.keying = 'pq-hybrid-2077';
			e['meta.json'] = strToU8(JSON.stringify(m));
		});
		await expect(read(futureKeying)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

		const futureFormat = rezip(bytes, (e) => {
			const m = JSON.parse(strFromU8(e['meta.json'])) as { format: number };
			m.format = 4; // one past the newest generation this reader understands (3)
			e['meta.json'] = strToU8(JSON.stringify(m));
		});
		await expect(read(futureFormat)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

		// The password-envelope format (3) exists, so a group file RELABELED as
		// it is not "newer" - it is a forgery: keying and format must agree.
		const relabeled = rezip(bytes, (e) => {
			const m = JSON.parse(strFromU8(e['meta.json'])) as { format: number };
			m.format = 3;
			e['meta.json'] = strToU8(JSON.stringify(m));
		});
		await expect(read(relabeled)).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});

	it('writeBox refuses group + password together', async () => {
		const alice = await generateIdentity();
		await expect(
			writeBox(snapshot, {
				...meta,
				password: 'pw',
				group: { recipients: [alice.encPub], sign: { pub: alice.sigPub, priv: alice.sigPriv } }
			})
		).rejects.toThrow(TypeError);
	});
});

// Regressions for the 0.0.5 group-crypto hardening audit. Each pins a specific
// finding so it cannot silently return.
describe('audit hardening', () => {
	async function groupBox(recipients: string[], signer = { s: '', e: '' }) {
		const alice = await generateIdentity();
		const sign = signer.s
			? { pub: signer.s, priv: signer.e }
			: { pub: alice.sigPub, priv: alice.sigPriv };
		return {
			alice,
			bytes: await writeBox(snapshot, { ...meta, group: { recipients, sign } })
		};
	}

	it('AUDIT-B1: the group read refuses to open without a pinned author list', async () => {
		const victim = await generateIdentity();
		const attacker = await generateIdentity(); // in no manifest
		const { bytes } = await groupBox([victim.encPub, attacker.encPub], {
			s: attacker.sigPub,
			e: attacker.sigPriv
		});
		// Omitting `authors` must fail closed - a self-declared author is not trust.
		await expect(
			readBoxWithSync(bytes, undefined, { identity: victim } as never)
		).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
		// With authors pinned (attacker not among them), it is refused as untrusted.
		await expect(
			readBoxWithSync(bytes, undefined, { identity: victim, authors: [victim.sigPub] })
		).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
	});

	it('AUDIT-A-F1: a data key that is not 32 bytes is refused (no silent AES-128)', async () => {
		const a = await generateIdentity();
		await expect(sealDataKey(new Uint8Array(16), [a.encPub])).rejects.toThrow(/32 bytes/);
	});

	it('AUDIT-A-F4/B3: too many recipient stanzas is refused before per-stanza work', async () => {
		const a = await generateIdentity();
		const many = Array.from({ length: 257 }, () => a.encPub);
		await expect(sealDataKey(new Uint8Array(32), many)).rejects.toThrow(/too many/i);
		await expect(
			openDataKey(
				Array.from({ length: 257 }, () => ({ kid: 'x', epk: 'x', iv: 'x', wrap: 'x' })),
				a
			)
		).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});

	it('AUDIT-A-F2: openManifest rejects duplicate member ids and non-32-byte keys', async () => {
		const admin = await generateIdentity();
		const b = await generateIdentity();
		const dup: GroupManifest = {
			v: 1,
			group: newGroupId(),
			seq: 1,
			admin: admin.sigPub,
			members: [
				{ id: 'x', sig: admin.sigPub, enc: admin.encPub },
				{ id: 'x', sig: b.sigPub, enc: b.encPub }
			]
		};
		await expect(
			openManifest(await signManifest(dup, admin.sigPriv), admin.sigPub)
		).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});
		const badKey: GroupManifest = {
			...dup,
			members: [{ id: 'x', sig: 'AAAA', enc: admin.encPub }] // sig not 32 bytes
		};
		await expect(
			openManifest(await signManifest(badKey, admin.sigPriv), admin.sigPub)
		).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
	});

	it('AUDIT-A-F3: openManifest binds to the expected group id when given', async () => {
		const admin = await generateIdentity();
		const m: GroupManifest = {
			v: 1,
			group: newGroupId(),
			seq: 1,
			admin: admin.sigPub,
			members: [{ id: 'a', sig: admin.sigPub, enc: admin.encPub }]
		};
		const signed = await signManifest(m, admin.sigPriv);
		expect((await openManifest(signed, admin.sigPub, m.group)).group).toBe(m.group);
		await expect(openManifest(signed, admin.sigPub, newGroupId())).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});
	});

	it('AUDIT-B2: format 2 and the keying field must agree (no mode confusion)', async () => {
		const alice = await generateIdentity();
		const bytes = await writeBox(snapshot, {
			...meta,
			group: { recipients: [alice.encPub], sign: { pub: alice.sigPub, priv: alice.sigPriv } }
		});
		// Strip `keying` but keep format 2: must fail closed, never fall to a plain read.
		const stripped = rezip(bytes, (e) => {
			const m = JSON.parse(strFromU8(e['meta.json'])) as Record<string, unknown>;
			delete m.keying;
			e['meta.json'] = strToU8(JSON.stringify(m));
		});
		await expect(
			readBoxWithSync(stripped, undefined, { identity: alice, authors: [alice.sigPub] })
		).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});
});
