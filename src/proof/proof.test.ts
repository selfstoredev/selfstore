/**
 * prove / verify / completeProof against an in-memory notary: only the digest
 * and the label reach the notary, the receipt lands next to the file in the
 * user's store, and a notary that answers for something else is not believed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { completeProof, prove, PROOFS, verify, type Notary, type Receipt } from './proof';
import { selfstore, type SimpleStore } from '../simple/simple';
import { memoryCache } from '../persistence/cache';
import { isSelfstoreError } from '../selfstore/errors';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const HELLO_HASH = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';

/** A notary that dates on deposit and anchors on `complete`, recording what it saw. */
function memoryNotary(overrides: Partial<Notary> = {}): Notary & { seen: unknown[][] } {
	const seen: unknown[][] = [];
	return {
		name: 'memory',
		seen,
		deposit(hash: string, label?: string): Promise<Receipt> {
			seen.push([hash, label]);
			return Promise.resolve({
				notary: 'memory',
				hash,
				...(label === undefined ? {} : { label }),
				depositedAt: '2026-10-11T18:00:00.000Z',
				complete: false,
				evidence: { place: '7' }
			});
		},
		complete(receipt: Receipt): Promise<Receipt> {
			return Promise.resolve({
				...receipt,
				complete: true,
				evidence: { ...receipt.evidence, anchor: 'abc' }
			});
		},
		...overrides
	};
}

const open: SimpleStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function store(): Promise<SimpleStore> {
	const s = await selfstore('proof-test', { cache: memoryCache() });
	open.push(s);
	return s;
}

describe('prove', () => {
	it('sends the digest and the label, nothing else, and measures the bytes itself', async () => {
		const notary = memoryNotary();
		const proof = await prove(bytes('hello\n'), { notary, label: 'inventory' });
		expect(notary.seen).toEqual([[HELLO_HASH, 'inventory']]);
		expect(proof).toMatchObject({
			kind: 'selfstore-proof',
			version: 1,
			algorithm: 'SHA-256',
			hash: HELLO_HASH,
			size: 6,
			label: 'inventory',
			notary: 'memory',
			complete: false,
			evidence: { place: '7' }
		});
		expect(proof.file).toBeUndefined();
	});

	it('accepts a Blob and an ArrayBuffer as well as bytes', async () => {
		const fromBlob = await prove(new Blob(['hello\n']), { notary: memoryNotary() });
		const fromBuffer = await prove(bytes('hello\n').buffer as ArrayBuffer, {
			notary: memoryNotary()
		});
		expect(fromBlob.hash).toBe(HELLO_HASH);
		expect(fromBuffer.hash).toBe(HELLO_HASH);
	});

	it('keeps the receipt next to the file, keyed by the file id', async () => {
		const s = await store();
		const file = await s.putFile({
			name: 'inventory.pdf',
			mime: 'application/pdf',
			bytes: bytes('hello\n')
		});
		const proof = await prove(s.getFile(file)!.bytes, { notary: memoryNotary(), store: s, file });
		expect(s.get(PROOFS, file)).toMatchObject({ id: file, file, hash: proof.hash });
	});

	it('keys the receipt by digest when there is no file', async () => {
		const s = await store();
		await prove(bytes('hello\n'), { notary: memoryNotary(), store: s });
		expect(s.get(PROOFS, HELLO_HASH)).toMatchObject({ hash: HELLO_HASH });
	});

	it('refuses a notary that answers for another digest, and keeps nothing', async () => {
		const s = await store();
		const liar = memoryNotary({
			deposit: () =>
				Promise.resolve({
					notary: 'memory',
					hash: '0'.repeat(64),
					depositedAt: '2026-10-11T18:00:00.000Z',
					complete: true,
					evidence: {}
				})
		});
		const failure = await prove(bytes('hello\n'), { notary: liar, store: s }).catch(
			(e: unknown) => e
		);
		expect(isSelfstoreError(failure) && failure.code).toBe('NOTARY_REFUSED');
		expect(s.all(PROOFS)).toEqual([]);
	});

	it('refuses a receipt issued in another notary name, or with no readable time', async () => {
		const renamed = memoryNotary({
			deposit: (hash) =>
				Promise.resolve({
					notary: 'other',
					hash,
					depositedAt: '2026-10-11T18:00:00Z',
					complete: true,
					evidence: {}
				})
		});
		const timeless = memoryNotary({
			deposit: (hash) =>
				Promise.resolve({
					notary: 'memory',
					hash,
					depositedAt: 'soon',
					complete: true,
					evidence: {}
				})
		});
		await expect(prove(bytes('x'), { notary: renamed })).rejects.toMatchObject({
			code: 'NOTARY_REFUSED'
		});
		await expect(prove(bytes('x'), { notary: timeless })).rejects.toMatchObject({
			code: 'NOTARY_REFUSED'
		});
	});
});

describe('completeProof', () => {
	it('adds what the notary could not give at once, keeping what the device measured', async () => {
		const s = await store();
		const notary = memoryNotary();
		const pending = await prove(bytes('hello\n'), { notary, file: 'f1' });
		const done = await completeProof(pending, { notary, store: s });
		expect(done).toMatchObject({
			complete: true,
			size: 6,
			file: 'f1',
			evidence: { place: '7', anchor: 'abc' }
		});
		expect(s.get(PROOFS, 'f1')).toMatchObject({ complete: true });
	});

	it('does not call the notary for a complete proof', async () => {
		const notary = memoryNotary({
			complete: () => Promise.reject(new Error('must not be called'))
		});
		const pending = await prove(bytes('hello\n'), { notary });
		const complete = { ...pending, complete: true };
		expect(await completeProof(complete, { notary })).toBe(complete);
	});

	it('refuses a completion that swaps the digest', async () => {
		const notary = memoryNotary({
			complete: (r) => Promise.resolve({ ...r, hash: 'f'.repeat(64), complete: true })
		});
		const pending = await prove(bytes('hello\n'), { notary });
		await expect(completeProof(pending, { notary })).rejects.toMatchObject({
			code: 'NOTARY_REFUSED'
		});
	});
});

describe('verify', () => {
	it('matches the bytes the receipt was made for', async () => {
		const proof = await prove(bytes('hello\n'), { notary: memoryNotary() });
		expect(await verify(new Blob(['hello\n']), proof)).toEqual({
			matches: true,
			hash: HELLO_HASH,
			complete: false
		});
	});

	it('does not match a document changed by one byte', async () => {
		const proof = await prove(bytes('hello\n'), { notary: memoryNotary() });
		const check = await verify(bytes('hellO\n'), proof);
		expect(check.matches).toBe(false);
		expect(check.hash).not.toBe(HELLO_HASH);
	});

	it('reads a receipt that only carries the digest, in either case', async () => {
		const check = await verify(bytes('hello\n'), {
			hash: HELLO_HASH.toUpperCase(),
			complete: true
		});
		expect(check).toEqual({ matches: true, hash: HELLO_HASH, complete: true });
	});

	it('does not match when the size disagrees', async () => {
		expect(
			(await verify(bytes('hello\n'), { hash: HELLO_HASH, complete: true, size: 7 })).matches
		).toBe(false);
	});

	it('refuses a receipt with no digest as BAD_FORMAT rather than a mismatch', async () => {
		await expect(verify(bytes('x'), { hash: 'nope', complete: true })).rejects.toMatchObject({
			code: 'BAD_FORMAT'
		});
		await expect(verify(bytes('x'), null as never)).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});
});
