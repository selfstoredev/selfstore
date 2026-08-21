/**
 * Reads the label packs of every widget as TEXT, for the suites that hold them
 * to a rule (`lexicon.test.ts`, `typographie.test.ts`). Test-only: it touches
 * the filesystem and is never bundled - no entry point imports it.
 *
 * Reading the source rather than importing the packs is deliberate. It covers
 * ALL of them at once, including the screens no DOM test happens to reach, and
 * it sees what is WRITTEN in the file - an escape, a raw character, an HTML
 * entity - where the runtime would hand back the same string for all three.
 *
 * The first version of this reader was a line regex living in lexicon.test.ts,
 * and it read only values that fit on ONE line. Two of the longest French
 * sentences in the library - the warning behind the forgotten password, and the
 * WebDAV URL help - are wrapped by prettier onto their own line, so they were
 * invisible to it. A reader that silently drops the longest strings is worse
 * than none: those are exactly the ones that wrap on a narrow screen.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** By code point: a lone backslash is the one character a file about invisible
 *  characters should not spell out. */
const BACKSLASH = 0x5c;

/** One entry of a pack: its key, and what its value is made of. */
export type Label = {
	readonly key: string;
	/** As WRITTEN in the source, escapes untouched. */
	readonly raw: string;
	/** What the runtime hands out: escape sequences resolved. */
	readonly text: string;
};

/** Widgets that ship packs, read from the directory and never from a list. A
 *  hardcoded one was this reader's first version, and it already missed a
 *  widget added the same week. */
export const WIDGETS: readonly string[] = readdirSync(here)
	.filter((f) => f.endsWith('.ts') && !f.includes('.test'))
	.map((f) => f.replace(/\.ts$/, ''))
	.filter((name) => /^(export )?const FR\b/m.test(readFileSync(join(here, `${name}.ts`), 'utf8')));

const SIMPLE: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

/**
 * Resolve the escapes a JS string literal may carry, so the rules see the
 * character the runtime hands out rather than the six characters written in
 * the file. This is the whole point of welding with an escape: to a regex
 * reading the source as text, the escape is not a space at all.
 *
 * Walked rather than matched: every pattern that would do this job has to
 * spell a backslash.
 */
function resolve(raw: string): string {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		if (raw.charCodeAt(i) !== BACKSLASH) {
			out += raw[i];
			i += 1;
			continue;
		}
		const mark = raw[i + 1];
		if (mark === 'u' && raw[i + 2] === '{') {
			const end = raw.indexOf('}', i);
			out += String.fromCodePoint(parseInt(raw.slice(i + 3, end), 16));
			i = end + 1;
		} else if (mark === 'u') {
			out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
			i += 6;
		} else if (mark === 'x') {
			out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16));
			i += 4;
		} else {
			out += SIMPLE[mark] ?? mark;
			i += 2;
		}
	}
	return out;
}

/** Index just past the quote that closes the literal opened at `from`. */
function afterLiteral(source: string, from: number, quote: string): number {
	let i = from + 1;
	while (i < source.length) {
		if (source.charCodeAt(i) === BACKSLASH) i += 2;
		else if (source[i] === quote) return i;
		else i += 1;
	}
	return source.length;
}

const QUOTES = new Set(["'", '"', '`']);

/**
 * Walk an object literal from its opening brace to the brace that closes it,
 * collecting the string literals inside. A char walk rather than a regex
 * because the two hazards here are the same one seen twice: a quote inside a
 * comment (a pack explains its own wording in French, apostrophes included)
 * and a `//` inside a string would each open something the other never closes.
 */
function literalsOf(source: string, declaration: RegExp): { key: string; raw: string }[] {
	const at = source.search(declaration);
	if (at === -1) return [];
	const open = source.indexOf('{', at);
	if (open === -1) return [];

	const out: { key: string; raw: string }[] = [];
	let depth = 0;
	let key = '';
	let i = open;
	while (i < source.length) {
		const c = source[i];
		if (c === '{') {
			depth += 1;
			i += 1;
		} else if (c === '}') {
			depth -= 1;
			if (depth === 0) break;
			i += 1;
		} else if (c === '/' && source[i + 1] === '/') {
			const eol = source.indexOf('\n', i);
			if (eol === -1) break;
			i = eol + 1;
		} else if (c === '/' && source[i + 1] === '*') {
			i = source.indexOf('*/', i) + 2;
		} else if (QUOTES.has(c)) {
			const end = afterLiteral(source, i, c);
			const raw = source.slice(i + 1, end);
			// A literal that a colon follows names the entry; anything else is
			// part of its value, which may be several literals concatenated.
			if (/^\s*:/.test(source.slice(end + 1))) key = raw;
			else out.push({ key, raw });
			i = end + 1;
		} else {
			i += 1;
		}
	}
	return out;
}

/** The pack of a widget, in the language whose constant is named `name`. */
export function pack(widget: string, name: 'EN' | 'FR'): Label[] {
	const source = readFileSync(join(here, `${widget}.ts`), 'utf8');
	const declaration = name === 'EN' ? /^(export )?const EN\b/m : /^(export )?const FR\b/m;
	return literalsOf(source, declaration).map(({ key, raw }) => ({
		key,
		raw,
		text: resolve(raw)
	}));
}
