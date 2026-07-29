// The BackupsHost port, wired over the Drive target's own operations.
//
// The manager is deliberately injectable: it drives a destination through the
// port and knows nothing about Drive. But the library already ships every
// operation that port asks for - list, open-by-id, create, rename, delete,
// find-or-create the personal file - so every app wiring them together again
// was writing the same adapter, and getting the same three details wrong:
//
//   - `open` must be a target over a FIXED id (`preview`), not a connect: a
//     connect re-resolves by name and would silently merge two backups.
//   - the active id lives under the SAME kv key the connect path reads, or a
//     reload adopts a different file than the one on screen.
//   - a listing must not raise the reconnect gate: `ensureSession` re-consents
//     first, so a lapsed session is a question, not an error.
//
// This is that adapter, once.

import type { BackupFileInfo, BackupsHost } from './manager';
import type { BackupTarget } from '../persistence/target';
import type { DriveOptions } from '../persistence/targets/drive';
import {
	FILE_ID_KEY,
	createBackup,
	deleteBackup,
	findOrCreateOwnFile,
	listBackups,
	preview,
	renameBackup
} from '../persistence/targets/drive';

export interface DriveBackupsHostOptions extends DriveOptions {
	/** Narrow the listing server-side to names containing this fragment (the
	 *  app's own stem, typically). The manager still applies its naming rules on
	 *  what comes back, so this is a bandwidth hint and never a filter to rely
	 *  on for correctness. Default: the whole visible listing. */
	nameContains?: string;
}

/**
 * The Drive destination as a `BackupsHost`, ready for `createBackupsManager`
 * (and therefore for `<selfstore-backups>`).
 *
 * ```ts
 * const manager = createBackupsManager({
 *   store: store.engine,
 *   kv: store.kv,
 *   host: driveBackupsHost({ auth, kv: store.kv, fileName: 'app.zip' }),
 *   naming: { canonicalName: 'app.zip' }
 * });
 * ```
 *
 * The `drive.file` scope already narrows what a listing can see to the files
 * this app created or was handed, so nothing here can enumerate a user's Drive.
 */
export function driveBackupsHost(opts: DriveBackupsHostOptions): BackupsHost {
	return {
		kind: 'drive',
		activeIdKey: FILE_ID_KEY,

		async list(): Promise<BackupFileInfo[]> {
			return listBackups({ auth: opts.auth, nameContains: opts.nameContains });
		},

		open(fileId: string): BackupTarget {
			// `preview`, not `connect`: a target bound to this exact id, and it
			// writes nothing to the kv - the manager decides what becomes active.
			return preview(opts, fileId);
		},

		async create(fileName: string): Promise<{ fileId: string }> {
			return createBackup({ auth: opts.auth, fileName });
		},

		async remove(fileId: string): Promise<void> {
			return deleteBackup({ auth: opts.auth, fileId });
		},

		async rename(fileId: string, fileName: string): Promise<void> {
			return renameBackup({ auth: opts.auth, fileId, fileName });
		},

		async findOrCreatePersonal(): Promise<{ fileId: string; created: boolean } | null> {
			return findOrCreateOwnFile(opts);
		},

		async ensureSession(): Promise<boolean> {
			// A live token is the cheap answer. Only when there is none does the
			// user get a consent popup - and refusing it is an answer, not a
			// failure: the caller aborts the gesture as cancelled.
			try {
				await opts.auth.token();
				return true;
			} catch {
				return opts.auth.reconnect();
			}
		}
	};
}
