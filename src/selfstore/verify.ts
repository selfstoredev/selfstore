/**
 * Read a freshly written backup back, before anyone is told it exists.
 *
 * A backup encrypted with a key nobody can reproduce, truncated, or built from
 * an empty snapshot looks exactly like a good one: right name, right date,
 * plausible size. The difference only shows up on the day of the disaster, when
 * it is far too late to make another. The only way to know is to open it.
 *
 * The cost is one decrypt of data the app already holds - a few hundred
 * milliseconds at these sizes, once per save. Cheap enough that the honest
 * default is to do it, and cheap enough that a host doing it on every write is
 * not being wasteful.
 */

import { SelfstoreError } from './errors';
import { importSnapshot } from './index';
import type { Snapshot } from './types';

/** What the caller believes it just wrote. */
export interface ExpectedContents {
	/** Per-collection record counts. Only the named collections are checked, so
	 *  a caller can pin the two that matter instead of listing everything. */
	counts?: Record<string, number>;
	/** Number of binary files. */
	files?: number;
}

/**
 * Open `bytes` and check they hold what was meant to be written. Throws
 * VERIFY_FAILED otherwise - never returns false, because a caller that ignores
 * a boolean is exactly how a backup that lies gets announced as done.
 */
export async function verifyBackup(
	bytes: Blob | Uint8Array,
	opts: { password?: string; expect?: ExpectedContents } = {}
): Promise<void> {
	let read: Snapshot;
	try {
		read = await importSnapshot(bytes, { password: opts.password });
	} catch {
		// The password is the likeliest culprit and the most expensive one to
		// discover late: an archive nobody can open is not a backup.
		throw new SelfstoreError('VERIFY_FAILED', 'The backup just written could not be read back.');
	}
	const expect = opts.expect;
	if (!expect) return;
	for (const [name, count] of Object.entries(expect.counts ?? {})) {
		const got = read.collections[name]?.length ?? 0;
		if (got !== count) {
			throw new SelfstoreError(
				'VERIFY_FAILED',
				`The backup just written holds ${got} "${name}" where ${count} were expected.`
			);
		}
	}
	if (expect.files !== undefined && read.files.length !== expect.files) {
		throw new SelfstoreError(
			'VERIFY_FAILED',
			`The backup just written holds ${read.files.length} files where ${expect.files} were expected.`
		);
	}
}

/** Every collection's record count, for a caller that wants the whole snapshot
 *  checked rather than picking which parts matter. */
export function countsOf(snapshot: Snapshot): ExpectedContents {
	const counts: Record<string, number> = {};
	for (const [name, rows] of Object.entries(snapshot.collections)) {
		counts[name] = rows.length;
	}
	return { counts, files: snapshot.files.length };
}
