import { describe, expect, it } from 'vitest';
import { byCodePoint } from './ordering.js';

describe('byCodePoint', () => {
	it('orders by code point, in both directions and for equals', () => {
		expect(byCodePoint('a', 'b')).toBe(-1);
		expect(byCodePoint('b', 'a')).toBe(1);
		expect(byCodePoint('a', 'a')).toBe(0);
	});

	it('agrees with a bare sort, which is the behaviour being preserved', () => {
		const names = ['x-amz-date', 'host', 'x-amz-content-sha256', 'Content-Type'];
		expect([...names].sort(byCodePoint)).toEqual([...names].sort());
	});

	it('does NOT agree with a locale-aware comparison, which is the point', () => {
		/*
		 * The order an analyser suggests for any bare `.sort()`. It puts these two
		 * the other way round, and both callers here would break: a signature the
		 * service rejects, and two devices hashing one unchanged record two ways.
		 */
		const names = ['a', 'B'];
		expect([...names].sort(byCodePoint)).toEqual(['B', 'a']);
		expect([...names].sort((x, y) => x.localeCompare(y))).toEqual(['a', 'B']);
	});
});
