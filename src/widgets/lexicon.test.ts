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
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Read from the directory, never from a list. A hardcoded one was this file's
 *  own first version, and it already missed a widget added the same week. */
const WIDGETS = readdirSync(here)
	.filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
	.map((f) => f.replace(/\.ts$/, ''))
	.filter((name) => readFileSync(join(here, `${name}.ts`), 'utf8').includes('const FR'));

/** The French pack of a widget, as key/value pairs read from its source. */
function frenchPack(widget: string): [string, string][] {
	const src = readFileSync(join(here, `${widget}.ts`), 'utf8');
	const start = src.indexOf('const FR');
	if (start === -1) return [];
	const block = src.slice(start, src.indexOf('\n};', start));
	return [...block.matchAll(/^\t'([^']+)':\s*(.+?),?$/gm)].map((m) => [m[1], m[2]]);
}

describe('the French packs hold to their declared lexicon', () => {
	it('never calls the durable destination "la destination"', () => {
		const offenders: string[] = [];
		for (const widget of WIDGETS) {
			for (const [key, value] of frenchPack(widget)) {
				if (/destination/i.test(value)) offenders.push(`${widget}: ${key} -> ${value}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('reads a pack for every widget, so a rename cannot silence this file', () => {
		for (const widget of WIDGETS) {
			expect(frenchPack(widget).length, `${widget} has no French pack`).toBeGreaterThan(0);
		}
	});
});
