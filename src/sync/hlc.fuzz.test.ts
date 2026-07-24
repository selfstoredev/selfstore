/**
 * Property-style fuzzing for the hybrid logical clock, companion to
 * merge.fuzz.test.ts. The example tests in hlc.test.ts pin the semantics;
 * this file drives RANDOM wall-clock walks (forward jumps, freezes, backward
 * jumps) and random multi-node exchanges, asserting on every history:
 *
 *   monotonicity    each stamp sorts strictly after the node's previous one
 *   wall floor      the encoded wall equals the running max of inputs
 *   receive         the folded clock sorts strictly after both its inputs
 *   uniqueness      no two stamps of a history are ever equal
 *
 * A failure prints its seed: add it as a fixed regression case.
 */

import { describe, it, expect } from 'vitest';
import { issue, receive, compare, hlcWall } from './hlc';

/** mulberry32: tiny deterministic PRNG so every run fuzzes the same walks. */
function mulberry(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	};
}

/** Next wall-clock reading: mostly forward, sometimes frozen, sometimes a
 *  backward jump of up to a minute (an NTP resync in the wild). */
function nextWall(wall: number, rand: () => number): number {
	const r = rand();
	if (r < 0.3) return wall; // same millisecond
	if (r < 0.45) return wall - Math.floor(rand() * 60_000); // clock moved back
	return wall + 1 + Math.floor(rand() * 5_000);
}

const STAMP_SHAPE = /^\d{15}\|\d{6}\|[^|]+$/;

describe('hlc fuzz', () => {
	it('a single node stays strictly monotonic through any clock walk', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rand = mulberry(seed);
			let wall = 1_700_000_000_000;
			let prev = null as string | null;
			let maxSeen = 0;
			for (let i = 0; i < 100; i++) {
				wall = nextWall(wall, rand);
				maxSeen = Math.max(maxSeen, wall);
				const next = issue(prev, 'n', wall);
				expect(next, `seed ${seed} step ${i}`).toMatch(STAMP_SHAPE);
				if (prev) expect(compare(next, prev), `seed ${seed} step ${i}`).toBeGreaterThan(0);
				expect(hlcWall(next), `seed ${seed} step ${i}`).toBe(maxSeen);
				prev = next;
			}
		}
	});

	it('receive always lands strictly after both inputs, and stamps never collide', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rand = mulberry(seed ^ 0x9e3779b9);
			const nodes = ['alpha', 'beta', 'gamma'];
			const clocks: (string | null)[] = [null, null, null];
			const walls = [1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000];
			const seen = new Set<string>();
			for (let i = 0; i < 120; i++) {
				const a = Math.floor(rand() * nodes.length);
				walls[a] = nextWall(walls[a], rand);
				if (rand() < 0.35 && clocks[(a + 1) % 3]) {
					// One node observes another's clock (a sync exchange).
					const remote = clocks[(a + 1) % 3] as string;
					const local = clocks[a];
					const folded = receive(local, remote, nodes[a], walls[a]);
					expect(compare(folded, remote), `seed ${seed} step ${i}`).toBeGreaterThan(0);
					if (local) expect(compare(folded, local), `seed ${seed} step ${i}`).toBeGreaterThan(0);
					clocks[a] = folded;
				} else {
					clocks[a] = issue(clocks[a], nodes[a], walls[a]);
				}
				const stamp = clocks[a] as string;
				expect(seen.has(stamp), `seed ${seed} step ${i}: duplicate ${stamp}`).toBe(false);
				seen.add(stamp);
			}
		}
	});
});
