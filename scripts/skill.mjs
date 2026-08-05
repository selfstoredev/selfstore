#!/usr/bin/env node
/*
 * THE SKILL DESCRIBES THIS LIBRARY, NOT THE ONE IT DESCRIBED LAST YEAR.
 *
 *     npm run skill
 *
 * `skills/selfstore/SKILL.md` is instructions for a model about an API it has
 * never seen, and it is the THIRD place this surface is written down after
 * llms.txt and the site. Three copies drift; this is what stops the drift being
 * silent.
 *
 * It is deliberately a different document from llms.txt rather than a shorter
 * one. llms.txt is the reference a model reads when it has been pointed at it.
 * The skill is what fires unasked at the moment code gets written, so it
 * carries the decision (is this even the right tool) and the five things a
 * first integration gets wrong, and hands the reference over for the rest.
 *
 * Three cheap checks, and what each does NOT prove is said out loud:
 *
 *   1. every function the skill calls still exists in `src`. This catches a
 *      RENAME, which is the case that hurts, and it does not check the
 *      arguments - the compiler cannot be pointed at prose.
 *   2. every subpath it names is still in `package.json` exports. `groups` is
 *      documented as withdrawable in a minor, so this one is not theoretical.
 *   3. the plugin manifest carries the package version, because the skill
 *      documents a surface and should say which.
 *
 * Found by writing it: `connectS3` was public and absent from llms.txt, so a
 * model reading the reference could not know the method existed. Whichever copy
 * is checked, the check is what makes the others worth trusting.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...path) => readFileSync(join(root, ...path), 'utf8');

const skill = read('skills', 'selfstore', 'SKILL.md');
const pkg = JSON.parse(read('package.json'));
const plugin = JSON.parse(read('.claude-plugin', 'plugin.json'));

const problems = [];

function walk(directory) {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/* The source, tests excluded: a name kept alive only by a test is not a name a
 * consumer can call. */
const source = walk(join(root, 'src'))
	.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
	.map((file) => readFileSync(file, 'utf8'))
	.join('\n');

/* The language, and the names the snippets declare for themselves. Kept short
 * on purpose: a long list here is a check that has stopped checking. */
const NOT_OURS = new Set([
	'crypto',
	'randomUUID',
	'require',
	'if',
	'for',
	'while',
	'return',
	'cat'
]);

/* `(?<![.\w$])` drops member calls; the paren has to touch the name, or every
 * word in the prose that precedes a bracket comes back as a missing export. */
const called = new Set(
	[...skill.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\(/gi)]
		.map((match) => match[1])
		.filter((name) => !NOT_OURS.has(name))
);

for (const name of called) {
	if (!new RegExp(`\\b${name}\\b`).test(source)) {
		problems.push(`the skill calls ${name}(), which appears nowhere in src`);
	}
}

/* 2. Every subpath it names. */
const subpaths = new Set(
	Object.keys(pkg.exports).map((name) => (name === '.' ? pkg.name : `${pkg.name}/${name.slice(2)}`))
);

for (const [, named] of skill.matchAll(/`(selfstore\/[a-z-]+)`/g)) {
	if (!subpaths.has(named)) problems.push(`the skill names \`${named}\`, which is not an export`);
}

/* 3. The manifest ships the version it documents. */
if (plugin.version !== pkg.version) {
	problems.push(
		`.claude-plugin/plugin.json says ${plugin.version} and the package is ${pkg.version} - ` +
			`bump both in the release PR, or the skill claims a surface it does not document`
	);
}

/* And the frontmatter a skill is loaded by. Absent, it never triggers at all. */
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
if (frontmatter === null) problems.push('SKILL.md has no frontmatter');
else {
	for (const field of ['name', 'description']) {
		if (!new RegExp(`^${field}:\\s*\\S`, 'm').test(frontmatter[1])) {
			problems.push(`SKILL.md frontmatter has no ${field}`);
		}
	}
}

if (problems.length > 0) {
	process.stderr.write('the skill and the library disagree:\n');
	for (const problem of problems) process.stderr.write(`  ${problem}\n`);
	process.exit(1);
}

process.stdout.write(
	`skill: ${called.size} call(s) and ${
		[...skill.matchAll(/`(selfstore\/[a-z-]+)`/g)].length
	} subpath(s) all exist, manifest at ${plugin.version}.\n`
);
