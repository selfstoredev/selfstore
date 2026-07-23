import { describe, it, expect } from 'vitest';
import { issue, receive, compare, max, createNode } from './hlc';

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
