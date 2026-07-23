// requireEncryption: a store told to require encryption must never emit a
// cleartext travelling copy. It refuses a passwordless attach, refuses to drop
// the password, and refuses a plaintext export even when nothing is connected.

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './store';
import { memoryCache } from './cache';
import type { BackupTarget } from './target';
import { inspect, isSelfstoreError, type Snapshot } from '../selfstore';

function memTarget(kind = 'drive') {
	let remote: Blob | null = null;
	let version = 0;
	const target: BackupTarget = {
		kind,
		label: kind,
		async save(b) {
			remote = b;
			version++;
			return String(version);
		},
		async load() {
			return remote;
		},
		async stat() {
			return remote ? String(version) : null;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {}
	};
	return {
		target,
		get remote() {
			return remote;
		}
	};
}

let seq = 0;
const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function makeStore(extra: Partial<LocalStoreOptions> = {}) {
	let collections: Record<string, unknown[]> = { notes: [{ id: 'n1', body: 'hello' }] };
	const store = createLocalStore({
		app: `req-enc-${++seq}`,
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(collections), files: [] }),
		apply: (snap: Snapshot) => {
			collections = structuredClone(snap.collections ?? {});
		},
		cache: memoryCache(),
		logger: { warn() {}, error() {} },
		...extra
	});
	open.push(store);
	await store.init();
	return store;
}

/** Run `fn`, returning the SelfstoreError code it threw (or null if it did not throw). */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
	try {
		await fn();
		return null;
	} catch (e) {
		return isSelfstoreError(e) ? e.code : `THREW:${(e as Error).name}`;
	}
}

describe('requireEncryption', () => {
	it('rejects a passwordless attach', async () => {
		const store = await makeStore({ requireEncryption: true });
		const t = memTarget();
		const code = await codeOf(() => store.attachTarget(t.target, { strategy: 'replace-remote' }));
		expect(code).toBe('ENCRYPTION_REQUIRED');
		expect(t.remote).toBeNull(); // nothing was written
	});

	it('accepts a password and writes ciphertext', async () => {
		const store = await makeStore({ requireEncryption: true });
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote', password: 'correct horse' });
		expect(t.remote).not.toBeNull();
		expect((await inspect(t.remote!)).encryption).not.toBe('none');
	});

	it('refuses to remove the password with setEncryption(null)', async () => {
		const store = await makeStore({ requireEncryption: true });
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote', password: 'first pass' });
		expect(await codeOf(() => store.setEncryption(null))).toBe('ENCRYPTION_REQUIRED');
		// Changing the password to another non-empty one is still allowed.
		await store.setEncryption('second pass');
		expect((await inspect(t.remote!)).encryption).not.toBe('none');
	});

	it('refuses a plaintext export even with nothing connected (backstop)', async () => {
		const store = await makeStore({ requireEncryption: true });
		expect(await codeOf(() => store.exportBlob())).toBe('ENCRYPTION_REQUIRED');
	});

	it('leaves the default off: a passwordless attach and plaintext export still work', async () => {
		const store = await makeStore();
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote' });
		expect((await inspect(t.remote!)).encryption).toBe('none');
		expect((await inspect(await store.exportBlob())).encryption).toBe('none');
	});
});

describe('passwordPolicy', () => {
	const policy = { minLength: 8, requireUppercase: true, requireDigit: true };

	it('rejects a weak password at attachTarget, accepts a strong one', async () => {
		const weak = await makeStore({ passwordPolicy: policy });
		const t1 = memTarget();
		expect(
			await codeOf(() =>
				weak.attachTarget(t1.target, { strategy: 'replace-remote', password: 'short' })
			)
		).toBe('WEAK_PASSWORD');
		expect(t1.remote).toBeNull();

		const strong = await makeStore({ passwordPolicy: policy });
		const t2 = memTarget();
		await strong.attachTarget(t2.target, { strategy: 'replace-remote', password: 'Abcdef12' });
		expect((await inspect(t2.remote!)).encryption).not.toBe('none');
	});

	it('rejects a weak password at setEncryption but accepts a strong one', async () => {
		const store = await makeStore({ passwordPolicy: policy });
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote', password: 'Abcdef12' });
		expect(await codeOf(() => store.setEncryption('weak'))).toBe('WEAK_PASSWORD');
		await store.setEncryption('Zyxwvu98');
		expect((await inspect(t.remote!)).encryption).not.toBe('none');
	});
});
