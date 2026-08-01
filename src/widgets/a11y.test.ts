// @vitest-environment happy-dom
/**
 * What the widgets owe someone who does not see them, or cannot use a mouse.
 * Each case here failed before the commit that added it, and each one is a
 * rule an app inherits without knowing it exists.
 *
 * The contrast case is arithmetic, not taste: the severity tokens are read as
 * TEXT, so they answer to 4.5:1 and not to the 3:1 of a graphic. Computing it
 * here means a future palette tweak cannot quietly drop below the line.
 */

import { describe, it, expect } from 'vitest';
import { baseStyles } from './base';
import { GLYPH } from './status';

/** Relative luminance, WCAG 2.1 definition. */
function luminance(hex: string): number {
	const parts = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
	return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The fallback baked into `var(--selfstore-NAME, #xxxxxx)`. */
function fallbackOf(name: string): string {
	const m = new RegExp(`--selfstore-${name},\\s*(#[0-9a-fA-F]{6})`).exec(baseStyles);
	if (!m) throw new Error(`no default declared for --selfstore-${name}`);
	return m[1];
}

/** The alpha baked into `var(--selfstore-NAME, color-mix(... currentColor N%, transparent))`. */
function alphaOf(name: string): number {
	const m = new RegExp(`--selfstore-${name},\\s*color-mix\\([^)]*currentColor (\\d+)%`).exec(
		baseStyles
	);
	if (!m) throw new Error(`no color-mix default declared for --selfstore-${name}`);
	return Number(m[1]) / 100;
}

/** What the browser paints for a partly transparent ink over an opaque page. */
function composite(ink: string, page: string, alpha: number): string {
	const channel = (i: number) =>
		Math.round(
			parseInt(ink.slice(i, i + 2), 16) * alpha + parseInt(page.slice(i, i + 2), 16) * (1 - alpha)
		)
			.toString(16)
			.padStart(2, '0');
	return `#${channel(1)}${channel(3)}${channel(5)}`;
}

describe('the default palette is readable', () => {
	// A widget renders on the host's background; white is the one every light
	// theme lands on, and the worst case for these two hues.
	it.each(['ok', 'warn', 'danger', 'accent'])(
		'--selfstore-%s clears 4.5:1 on white, because it is used as text',
		(name) => {
			expect(contrast(fallbackOf(name), '#ffffff')).toBeGreaterThanOrEqual(4.5);
		}
	);

	// The severity cases above read a hex straight out of the stylesheet, which
	// is why the dimmed ink escaped them for so long: it is an alpha, and an
	// alpha says nothing until it is painted over a page. These two are the
	// pages a widget actually lands on.
	it.each([
		['a light page', '#0f172a', '#ffffff'],
		['a dark page', '#e9e6e1', '#100f0d']
	])('--selfstore-muted clears 4.5:1 on %s, because subs and hints are text', (_, ink, page) => {
		expect(contrast(composite(ink, page, alphaOf('muted')), page)).toBeGreaterThanOrEqual(4.5);
	});

	it('does not lean on hue to separate two colors of equal lightness', () => {
		// Both were darkened to land just over the same threshold, so they now
		// share a luminance: on a greyscale screen, or to someone who sees no
		// color, "settled" and "needs you" are the same grey. That is fine only
		// because the severity also carries a glyph - this asserts the glyph, so
		// removing it would fail here rather than in someone's hands.
		expect(contrast(fallbackOf('ok'), fallbackOf('warn'))).toBeLessThan(1.5);
		expect(GLYPH.ok).not.toBe(GLYPH.warn);
		expect(GLYPH.ok).toBeTruthy();
	});
});

describe('motion and announcements are declared in the stylesheet', () => {
	it('the only animation stops under prefers-reduced-motion', () => {
		expect(baseStyles).toContain('animation: ss-spin');
		const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(baseStyles);
		expect(media, 'no reduced-motion block at all').not.toBeNull();
		expect(media![1]).toContain('animation: none');
	});
});
