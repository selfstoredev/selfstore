import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { backup, restore, changePassword, inspect, verifyBackup, type Snapshot } from './index';
import { unzip } from './archive';

function sample(): Snapshot {
	return {
		collections: { notes: [{ id: 'n1', body: 'hello' }] },
		files: [
			{ id: 'f1', name: 'doc.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }
		]
	};
}

describe('fluent API', () => {
	it('round-trips encrypted through backup() and restore()', async () => {
		const bytes = await backup(sample()).as('test-app', '7').encryptedWith('s3cret').toBytes();

		expect(await restore(bytes).isEncrypted()).toBe(true);
		const meta = await restore(bytes).meta();
		expect(meta.app).toBe('test-app');
		expect(meta.appVersion).toBe('7');
		expect(meta.format).toBe(3); // every encrypted write is the authenticated envelope now

		const back = await restore(bytes).withPassword('s3cret').read();
		expect(back.collections).toEqual(sample().collections);
		expect(back.files[0].bytes).toEqual(sample().files[0].bytes);
	});

	it('reads a plain backup without a password', async () => {
		const blob = await backup(sample()).as('test-app').toBlob();
		expect(await restore(blob).isEncrypted()).toBe(false);
		const back = await restore(blob).read();
		expect(back.collections).toEqual(sample().collections);
	});

	it('demands the app name before writing (no terminal before .as())', () => {
		// The chain is staged: backup() exposes only .as(), so calling a terminal
		// first is a compile-time error, not a runtime throw.
		const draft = backup(sample());
		expect('toBytes' in draft).toBe(false);
		expect(typeof (draft as unknown as { as: unknown }).as).toBe('function');
	});

	it('refuses reserved __-prefixed collections (library bookkeeping namespace)', () => {
		expect(() => backup({ collections: { __store: [] }, files: [] })).toThrow(/reserved/);
	});

	it('surfaces PASSWORD_REQUIRED when reading encrypted without a password', async () => {
		const bytes = await backup(sample()).as('a').encryptedWith('pw').toBytes();
		await expect(restore(bytes).read()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
	});
});

describe('readme branding', () => {
	it('ships a neutral readme by default (no app brand baked into the library)', async () => {
		const bytes = await backup(sample()).as('some-app').encryptedWith('pw').toBytes();
		const readme = strFromU8(unzipSync(bytes)['LISEZMOI.txt']);
		expect(readme).toContain('valid ZIP archive');
		// Neutral: it points at "the application that created it", never a brand.
		expect(readme).toContain('the application that created it');
	});

	it('ships the caller-branded readme when given', async () => {
		const bytes = await backup(sample())
			.as('my-app')
			.encryptedWith('pw')
			.withReadme('Import this file into MyApp with your password.')
			.toBytes();
		expect(strFromU8(unzipSync(bytes)['LISEZMOI.txt'])).toContain('MyApp');
	});
});

describe('format generation', () => {
	it('stamps format 1 and refuses a newer generation', async () => {
		const bytes = await backup(sample()).as('a').toBytes();
		expect((await inspect(bytes)).format).toBe(1);

		const entries = unzipSync(bytes);
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		meta.format = 99;
		const { zipSync, strToU8 } = await import('fflate');
		const doctored = zipSync({ ...entries, 'meta.json': strToU8(JSON.stringify(meta)) });
		await expect(restore(doctored).meta()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
	});
});

describe('changePassword', () => {
	it('re-encrypts under the new password and keeps the app identity', async () => {
		const original = await backup(sample()).as('test-app', '3').encryptedWith('old').toBytes();
		const rekeyed = await changePassword(original, { from: 'old', to: 'new' });

		const meta = await restore(rekeyed).meta();
		expect(meta.app).toBe('test-app');
		expect(meta.appVersion).toBe('3');

		const back = await restore(rekeyed).withPassword('new').read();
		expect(back.collections).toEqual(sample().collections);
		await expect(restore(rekeyed).withPassword('old').read()).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
	});

	it('removes the password when `to` is omitted', async () => {
		const original = await backup(sample()).as('a').encryptedWith('pw').toBytes();
		const opened = await changePassword(original, { from: 'pw' });
		expect(await restore(opened).isEncrypted()).toBe(false);
	});
});

describe('zip-bomb guard', () => {
	it('refuses an archive entry above the per-entry size limit', async () => {
		const bytes = await backup(sample()).as('a').toBytes();
		await expect(unzip(bytes, 8)).rejects.toMatchObject({ code: 'TOO_LARGE' });
	});

	it('refuses when the aggregate of legal entries exceeds the total limit', async () => {
		// Every entry passes the per-entry cap, but their SUM does not: many small
		// entries must not add up to a decompression bomb.
		const bytes = await backup(sample()).as('a').toBytes();
		await expect(unzip(bytes, 1_000_000, 8)).rejects.toMatchObject({ code: 'TOO_LARGE' });
	});

	it('opens with the recovery secret as well as with the password', async () => {
		// A password that lives only in one person's memory is the likeliest way a
		// local-first backup dies: nothing can reset it. A second slot around the
		// same data key is the whole remedy, and reading needs no new API.
		const bytes = await backup(sample())
			.as('test-app', '7')
			.encryptedWith('le-mot-de-passe')
			.alsoOpenedWith('CODE-DE-SECOURS-2026')
			.toBytes();

		expect(
			(await restore(bytes).withPassword('le-mot-de-passe').read()).collections.notes
		).toHaveLength(1);
		expect(
			(await restore(bytes).withPassword('CODE-DE-SECOURS-2026').read()).collections.notes
		).toHaveLength(1);
	});

	it('does not let one secret be read from the other, nor a third one in', async () => {
		const bytes = await backup(sample())
			.as('test-app')
			.encryptedWith('le-mot-de-passe')
			.alsoOpenedWith('CODE-DE-SECOURS-2026')
			.toBytes();

		await expect(restore(bytes).withPassword('autre-chose').read()).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
		// Deux slots, pas un de plus: le compte est verifiable sans dechiffrer.
		const meta = await restore(bytes).meta();
		expect(meta.keys).toHaveLength(2);
	});

	it('accepts several recovery secrets', async () => {
		const bytes = await backup(sample())
			.as('test-app')
			.encryptedWith('pw')
			.alsoOpenedWith('un')
			.alsoOpenedWith('deux')
			.toBytes();

		expect(await restore(bytes).withPassword('deux').read()).toBeTruthy();
		expect((await restore(bytes).meta()).keys).toHaveLength(3);
	});

	it('refuses an empty recovery secret rather than minting a slot for it', async () => {
		expect(() => backup(sample()).as('a').encryptedWith('pw').alsoOpenedWith('')).toThrow(
			TypeError
		);
	});

	it('verified() reads the backup back before handing it over', async () => {
		// The whole point: a backup nobody has reopened is not a backup. Here it
		// opens, so nothing changes for the caller.
		const bytes = await backup(sample()).as('test-app').encryptedWith('pw').verified().toBytes();
		expect((await restore(bytes).withPassword('pw').read()).collections.notes).toHaveLength(1);
	});

	it('survives being set anywhere in the chain', async () => {
		// Set on one link and dropped by the next is the silent failure this
		// feature exists to prevent, so the flag rides in the options.
		const early = await backup(sample()).as('a').verified().encryptedWith('pw').toBytes();
		const late = await backup(sample()).as('a').encryptedWith('pw').verified().toBytes();
		expect(early.length).toBeGreaterThan(0);
		expect(late.length).toBeGreaterThan(0);
	});

	it('refuses a backup whose contents do not match what went in', async () => {
		// Stand in for the real failure - an empty snapshot written while the app
		// believed it held data - by checking the counts contract directly.
		await expect(
			verifyBackup(await backup(sample()).as('a').encryptedWith('pw').toBytes(), {
				password: 'pw',
				expect: { counts: { notes: 99 } }
			})
		).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
	});

	it('refuses a backup that will not open with the secret it was sealed with', async () => {
		// The most expensive failure to discover late: an archive nobody can open.
		await expect(
			verifyBackup(await backup(sample()).as('a').encryptedWith('pw').toBytes(), {
				password: 'not-the-password'
			})
		).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
	});
});
