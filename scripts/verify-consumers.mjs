// Build the release candidate, then prove it against real applications before
// it reaches npm.
//
// A library with no outside users only learns it broke something after it has
// broken it. The usual answer is "wait for users"; the faster one is to point
// this at the applications that already depend on the library and let them fail
// here instead of in someone's release.
//
// It names no application: paths come from the command line, so the repo stays
// the standalone building block it claims to be.
//
//   node scripts/verify-consumers.mjs ../app-one ../app-two
//
// What it does to each application: packs the candidate, installs it with
// --no-save (nothing tracked is touched), runs the app's own build, then puts
// the previous dependency back. A failure is reported and the run continues, so
// one broken consumer does not hide the state of the others.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const NAME = 'selfstore';
const chemins = process.argv.slice(2);

if (chemins.length === 0) {
	console.error('usage: node scripts/verify-consumers.mjs <app-path> [<app-path>...]');
	process.exit(2);
}

/** Run a command, returning its combined output. Throws with the output kept,
 *  because the reason a build failed is the only useful part of the failure. */
function run(cmd, args, cwd) {
	return execFileSync(cmd, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32'
	});
}

function versionDe(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '?';
	} catch {
		return '?';
	}
}

console.log(`\ncandidate: ${NAME}@${versionDe(process.cwd())}`);

// One tarball for every consumer: the bytes each one installs are the bytes npm
// would publish, not a source folder that happens to resolve.
run('npm', ['run', 'build'], process.cwd());
const tarball = resolve(run('npm', ['pack', '--silent'], process.cwd()).trim().split('\n').pop());
console.log(`tarball:   ${basename(tarball)}\n`);

const resultats = [];
for (const brut of chemins) {
	const dir = resolve(brut);
	const nom = basename(dir);
	if (!existsSync(join(dir, 'package.json'))) {
		resultats.push([nom, 'skipped', 'no package.json there']);
		continue;
	}
	const avant = versionDe(join(dir, 'node_modules', NAME));
	try {
		// --no-save: package.json and the lockfile are left exactly as they are,
		// so this never shows up as a change in the application's repository.
		run('npm', ['install', tarball, '--no-save', '--silent'], dir);
		run('npm', ['run', 'build'], dir);
		resultats.push([nom, 'ok', `was on ${avant}`]);
	} catch (e) {
		const sortie = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n   ');
		resultats.push([nom, 'FAILED', sortie || String(e)]);
	} finally {
		// Put the application back where it was: a verification that leaves four
		// repositories pinned to an unpublished tarball is a trap for whoever
		// builds next, including a deploy.
		try {
			run('npm', ['ci', '--silent'], dir);
		} catch {
			resultats.push([nom, 'note', 'could not restore with npm ci - run it there by hand']);
		}
	}
}

rmSync(tarball, { force: true });

console.log('');
let casse = 0;
for (const [nom, etat, detail] of resultats) {
	if (etat === 'FAILED') casse++;
	console.log(`${etat.padEnd(8)} ${nom.padEnd(20)} ${detail.replaceAll('\n', '\n   ')}`);
}
console.log('');

if (casse > 0) {
	console.error(`${casse} application(s) no longer build against this candidate. Do not publish.`);
	process.exit(1);
}
console.log('every application still builds. Safe to release.');
