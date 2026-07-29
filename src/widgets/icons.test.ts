// @vitest-environment happy-dom
/**
 * The shipped destination glyphs. Two properties matter and neither is
 * cosmetic: a card must never render bare (that is what every consuming app
 * was working around), and drawing one must never reach a third party - a
 * library that promises the data stays put cannot fetch an image to draw its
 * own screen.
 */

import { describe, it, expect } from 'vitest';
import { defaultIcons } from './icons';

const KINDS = ['drive', 'file', 'webdav', 's3'] as const;

describe('defaultIcons', () => {
	it.each(KINDS)('%s has a glyph', (kind) => {
		expect(defaultIcons[kind]).toBeTruthy();
	});

	it.each(KINDS)('%s is inlined, never a request', (kind) => {
		const uri = defaultIcons[kind];
		expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
		expect(uri).not.toMatch(/https?:|\/\//);
	});

	it('draws no brand mark', () => {
		// The glyphs are neutral on purpose: redistributing a provider's
		// trademark inside a public package is not the same question as an
		// application displaying it. A host with the right to a real logo
		// passes it through `icons`.
		const all = Object.values(defaultIcons).join(' ').toLowerCase();
		for (const name of ['google', 'drive%20logo', 'dropbox', 'amazon', 'nextcloud']) {
			expect(all).not.toContain(name);
		}
	});
});
