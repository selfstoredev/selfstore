/**
 * The French packs declare a lexicon in connect.ts, just above them:
 *
 *   the durable destination is "la sauvegarde", the live copy is "cet
 *   appareil" (never a place the user can pick), the portable file is an
 *   "export". One verb, one meaning.
 *
 * Nothing held them to it. Two strings called the durable destination "la
 * destination" while twenty-eight called it "la sauvegarde", so the same
 * journey told a user to choose "une sauvegarde" and then reported that "cette
 * destination" already held one - implying they were two different things.
 *
 * A rule stated in a comment drifts one string at a time. This reads the packs
 * as text on purpose: the point is to cover all of them at once, including the
 * screens no DOM test happens to reach.
 *
 * The reader itself lives in packs.testkit.ts, shared with typographie.test.ts.
 * It was a line regex here, and it read only values that fit on ONE line: the
 * two longest French sentences in the library are wrapped by prettier and were
 * invisible to it. Two suites reading the packs their own way is a door - each
 * lets through what the other refuses.
 */

import { describe, it, expect } from 'vitest';
import { WIDGETS, pack } from './packs.testkit';

describe('the French packs hold to their declared lexicon', () => {
	it('never calls the durable destination "la destination"', () => {
		const offenders: string[] = [];
		for (const widget of WIDGETS) {
			for (const { key, text } of pack(widget, 'FR')) {
				if (/destination/i.test(text)) offenders.push(`${widget}: ${key} -> ${text}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('reads a pack for every widget, so a rename cannot silence this file', () => {
		for (const widget of WIDGETS) {
			expect(pack(widget, 'FR').length, `${widget} has no French pack`).toBeGreaterThan(0);
		}
	});
});
