import { describe, it, expect, vi } from 'vitest';
import { issue, receive, compare, max, createNode, driftedAhead, MAX_DRIFT_MS } from './hlc';

describe('drift bound', () => {
	const now = 1_700_000_000_000;

	it('accepts a clock at the bound and refuses the millisecond past it', () => {
		expect(driftedAhead(issue(null, 'a', now + MAX_DRIFT_MS), now)).toBe(false);
		expect(driftedAhead(issue(null, 'a', now + MAX_DRIFT_MS + 1), now)).toBe(true);
	});

	it('is about the future only: an old clock is ordinary data', () => {
		// A wall time in the past cannot be told apart from a device that was
		// offline for a week, so the bound never looks backwards.
		expect(driftedAhead(issue(null, 'a', 1000), now)).toBe(false);
	});
});

describe('createNode', () => {
	it('mints an id without randomUUID, and never from Math.random', () => {
		// randomUUID is exposed only in a secure context; getRandomValues is the
		// one that is always there, so it is the one the fallback uses.
		const real = globalThis.crypto;
		vi.stubGlobal('crypto', {
			getRandomValues: real.getRandomValues.bind(real)
		});
		const a = createNode();
		const b = createNode();
		vi.unstubAllGlobals();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
	});

	it('refuses to mint one where no WebCrypto exists at all', () => {
		vi.stubGlobal('crypto', undefined);
		expect(() => createNode()).toThrow(TypeError);
		vi.unstubAllGlobals();
	});
});

describe('hlc', () => {
	it('is monotonic even when the wall clock goes backwards', () => {
		const n = 'a';
		const t1 = issue(null, n, 1000);
		const t2 = issue(t1, n, 500); // clock jumped back
		expect(compare(t2, t1)).toBeGreaterThan(0);
	});

	it('breaks same-millisecond ties with a counter', () => {
		const n = 'a';
		const t1 = issue(null, n, 1000);
		const t2 = issue(t1, n, 1000);
		expect(compare(t2, t1)).toBeGreaterThan(0);
	});

	it('gives a deterministic total order across nodes (no ties)', () => {
		const a = issue(null, 'aaa', 1000);
		const b = issue(null, 'bbb', 1000);
		expect(compare(a, b)).not.toBe(0);
		// same wall and counter: tie-break by node id, stable both ways
		expect(Math.sign(compare(a, b))).toBe(-Math.sign(compare(b, a)));
	});

	it('receive keeps the local clock ahead of an observed remote', () => {
		const local = issue(null, 'a', 1000);
		const remote = issue(null, 'b', 5000);
		const folded = receive(local, remote, 'a', 1200);
		expect(compare(folded, remote)).toBeGreaterThan(0);
	});

	it('max returns the later clock and tolerates nulls', () => {
		const a = issue(null, 'a', 1000);
		const b = issue(null, 'a', 2000);
		expect(max(a, b)).toBe(b);
		expect(max(null, a)).toBe(a);
		expect(max(a, null)).toBe(a);
	});

	it('createNode never contains the encoding separator', () => {
		for (let i = 0; i < 20; i++) expect(createNode()).not.toContain('|');
	});
});
