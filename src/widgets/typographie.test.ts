/**
 * French typography, held on every label this library puts on a screen.
 *
 * In French a double sign (`:` `;` `?` `!` `»`) is separated from the word
 * before it, and `«` from the word after it. Written with an ordinary space,
 * a line break can fall in that gap and send the sign alone to the head of the
 * next line - which is what a narrow screen shows. The fix is U+00A0, and it
 * belongs IN the string: a pass that welds after the DOM is built is undone by
 * whatever rewrites the text next.
 *
 * Why this file exists at all: these labels are shipped in a package. The app
 * that consumes them renders French sentences no test of its own can see, and
 * that is exactly how thirteen unwelded phrases reached a production screen -
 * every consumer's suite was green, and the strings were never theirs.
 *
 * Three things the escape decides for us, and none of them are style:
 *
 * - The escape is the only spelling allowed. A raw U+00A0 typed into a literal
 *   is indistinguishable from a space when the file is read back, so it cannot
 *   be defended over time - and eslint's no-irregular-whitespace skips string
 *   contents by default, so nothing else would catch it.
 * - `&nbsp;` would be worse than nothing. Widget text reaches the DOM through
 *   `document.createTextNode`, which decodes no entity: the six characters
 *   would be read out loud to the user.
 * - The rule is FRENCH. In English no space precedes a colon, so a pack that
 *   grew one would be a French habit leaking into the other language, and the
 *   assertion below refuses it there.
 *
 * Out of scope, with the reason: the README shipped inside an encrypted backup
 * (`src/selfstore/box.ts`) is bilingual but deliberately ASCII, so it renders
 * in any ZIP viewer. It is a text file someone opens in an editor, not a line
 * that wraps to a phone. The last assertion holds it to the promise that makes
 * this exclusion true.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WIDGETS, pack, type Label } from './packs.testkit';

/** By code point, on this file's own doctrine: typed in, it would be a blank
 *  that the next reader cannot tell from a space. */
const NBSP = String.fromCharCode(0xa0);

/** A double sign with an ordinary space in front of it, or `«` with one behind. */
const UNWELDED = /[^\s«] [:;?!»]|« /;

/** Every French label of the library, widget by widget. */
const FRENCH: { widget: string; label: Label }[] = WIDGETS.flatMap((widget) =>
	pack(widget, 'FR').map((label) => ({ widget, label }))
);

function unwelded(entries: { widget: string; label: Label }[]): string[] {
	return entries
		.filter(({ label }) => UNWELDED.test(label.text))
		.map(({ widget, label }) => `${widget}: ${label.key} -> ${label.text}`);
}

describe('the French packs weld their punctuation to the word before it', () => {
	it('leaves no double sign that a line break can orphan', () => {
		expect(unwelded(FRENCH)).toEqual([]);
	});

	it('spells the non-breaking space as an escape, never as the character', () => {
		const inClear = FRENCH.filter(({ label }) => label.raw.includes(NBSP)).map(
			({ widget, label }) => `${widget}: ${label.key}`
		);
		expect(inClear).toEqual([]);
	});

	it('never writes an HTML entity, which widget text would read out in full', () => {
		const entities = FRENCH.filter(({ label }) => /&(nbsp|#160|#xA0);/i.test(label.raw)).map(
			({ widget, label }) => `${widget}: ${label.key}`
		);
		expect(entities).toEqual([]);
	});

	it('keeps the English packs free of the French space entirely', () => {
		const leaked = WIDGETS.flatMap((widget) =>
			pack(widget, 'EN')
				.filter((label) => label.text.includes(NBSP) || / [:;?!]/.test(label.text))
				.map((label) => `${widget}: ${label.key}`)
		);
		expect(leaked).toEqual([]);
	});
});

describe('the detector itself is measured, so a green run means something', () => {
	const cases: [string, boolean][] = [
		['Mot de passe oublié ?', true],
		['Fichier : {file}', true],
		['Connexion instable ; cette vue', true],
		['Vraiment ! Tout sera perdu', true],
		['il a dit « bonjour »', true],
		['il a dit « bonjour', true],
		[`Mot de passe oublié${NBSP}?`, false],
		[`Fichier${NBSP}: {file}`, false],
		[`il a dit «${NBSP}bonjour${NBSP}»`, false],
		// A sign glued to its word is correct French too; only the gap is wrong.
		['Où enregistrer?', false],
		// A ternary reads as two faults, and that is why the scope is the pack
		// VALUES and not the file: code never reaches this regex. Written down so
		// nobody widens the scope and then loosens the pattern to compensate.
		['a ? b : c', true]
	];

	it.each(cases)('%s -> unwelded=%s', (sample, expected) => {
		expect(UNWELDED.test(sample)).toBe(expected);
	});

	it('names the offending label rather than just failing', () => {
		const planted = [
			{ widget: 'connect', label: { key: 'connect.title', raw: 'x ?', text: 'x ?' } }
		];
		expect(unwelded(planted)).toEqual(['connect: connect.title -> x ?']);
	});
});

describe('the reader cannot go blind without this file going red', () => {
	// A glob that stops resolving, a pack renamed, a block boundary misread:
	// none of those turn the assertions above red, they turn them VACUOUS.
	it('still finds every widget that ships a French pack', () => {
		expect([...WIDGETS].sort()).toEqual([
			'account',
			'backups',
			'connect',
			'destination',
			'gate',
			'join',
			'kinds',
			'share',
			'status'
		]);
	});

	it('reads at least as many French labels as the day it was written', () => {
		expect(FRENCH.length).toBeGreaterThanOrEqual(193);
	});

	it('reads the values prettier wrapped onto their own line', () => {
		// These two are the longest sentences in the library and the first
		// reader missed both: it matched a key and a value on one line.
		const long = FRENCH.filter(({ label }) => label.text.length > 140);
		expect(long.map(({ label }) => label.key).sort()).toEqual([
			'backups.replica.webdav.help',
			'connect.password.forgot.warn'
		]);
	});

	it('skips the French comments that sit inside a pack', () => {
		// destination.ts explains its wording in French, colon included, between
		// two entries. Read as a value it would be a permanent false failure.
		const keys = pack('destination', 'FR').map((l) => l.key);
		expect(keys).toContain('destination.restore');
		expect(keys.some((k) => k.includes('Restaurer'))).toBe(false);
	});
});

describe('the exclusion this file grants stays true', () => {
	it('keeps the backup README ASCII, which is why it is not welded', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const box = readFileSync(join(here, '..', 'selfstore', 'box.ts'), 'utf8');
		const readme = box.slice(box.indexOf('const DEFAULT_README'), box.indexOf('export async'));
		// eslint-disable-next-line no-control-regex
		expect(readme.match(/[^\x00-\x7F]/g)).toBeNull();
	});
});
