/**
 * Disk-file backup target for a desktop shell (Tauri, and anything exposing the
 * same filesystem and dialog calls).
 *
 * The browser's File System Access API is Chromium-only and, inside a native
 * webview, usually absent altogether: on macOS and Linux the shell embeds
 * WebKit, which never shipped it. So the file destination would silently
 * degrade to download-on-demand in the one place where writing a real file is
 * easiest. This target restores it.
 *
 * What changes against the browser target is what gets persisted: a PATH, not a
 * handle. A path survives a restart, an app update and a backup of the profile
 * directory, and it needs no permission to be re-granted at each launch. The
 * store therefore reconnects silently where the browser asks for a click.
 *
 * The shell's own calls are INJECTED, never imported: this library keeps three
 * runtime dependencies, and a desktop toolkit is not going to be the fourth for
 * the sake of the web build that will never call it.
 */

import type { BackupTarget } from '../target';
import type { KV } from '../cache';
import { SelfstoreError } from '../../selfstore';

const PATH_KEY = 'desktopFilePath';

/** Filter shape shared by the save and open dialogs. */
export interface DesktopDialogFilter {
	name: string;
	extensions: string[];
}

/**
 * The filesystem and dialog calls this target needs, shaped so a host can pass
 * its shell's functions straight through with no adapter of its own.
 *
 * With Tauri v2 the whole wiring is the two plugin imports:
 *
 * ```ts
 * import { readFile, writeFile, stat, exists } from '@tauri-apps/plugin-fs';
 * import { save, open } from '@tauri-apps/plugin-dialog';
 * import { useDesktopFiles } from 'selfstore';
 *
 * useDesktopFiles({ readFile, writeFile, stat, exists, save, open });
 * ```
 *
 * Do that once at start-up and every `file` destination in this library runs on
 * a real path. Nothing else in a host changes.
 */
export interface DesktopFileBridge {
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	/** File metadata. Only `mtime` is read, and a shell that cannot report it
	 *  may leave it absent: the store then falls back to its own bookkeeping. */
	stat(path: string): Promise<{ mtime?: Date | number | null } | null>;
	exists(path: string): Promise<boolean>;
	/** Save dialog. Resolves to the chosen path, or null when cancelled. */
	save(options: { defaultPath?: string; filters?: DesktopDialogFilter[] }): Promise<string | null>;
	/** Open dialog. Resolves to the chosen path, or null when cancelled. The
	 *  array form is accepted so a host can pass its shell's function unchanged. */
	open(options: {
		multiple?: boolean;
		filters?: DesktopDialogFilter[];
	}): Promise<string | string[] | null>;
}

let bridge: DesktopFileBridge | null = null;

/**
 * Register the desktop shell's filesystem and dialog calls. Call once at
 * start-up, before opening the store. Passing null unregisters, which is what a
 * test wants between cases.
 */
export function useDesktopFiles(b: DesktopFileBridge | null): void {
	bridge = b;
}

/** True once a shell has been registered: the file destination then writes a
 *  real path instead of asking the browser for a handle. */
export function hasDesktopFiles(): boolean {
	return bridge != null;
}

const FILTERS: DesktopDialogFilter[] = [{ name: 'Backup', extensions: ['zip'] }];

/** Last path segment, for the label. Windows and POSIX separators both, since
 *  the same build runs on either. */
function baseName(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

/** Epoch milliseconds as the version marker, or null when the shell cannot
 *  tell. Never throws: a marker that cannot be read is "cannot tell", and the
 *  store treats that as no information rather than as a fault. */
async function markerOf(b: DesktopFileBridge, path: string): Promise<string | null> {
	try {
		const info = await b.stat(path);
		const mtime = info?.mtime;
		if (mtime == null) return null;
		const ms = mtime instanceof Date ? mtime.getTime() : Number(mtime);
		return Number.isFinite(ms) ? String(ms) : null;
	} catch {
		return null;
	}
}

/** Only the first path, whichever shape the shell's open dialog returns. */
function firstPath(picked: string | string[] | null): string | null {
	if (picked == null) return null;
	return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

function fromPath(path: string, b: DesktopFileBridge, kv: KV): BackupTarget {
	// reconnect() can move the destination to another file, so the path the
	// closure writes to has to be able to change under the object the store
	// already holds.
	let current = path;
	return {
		kind: 'file',
		get label(): string {
			return baseName(current);
		},
		async save(blob: Blob): Promise<string | null> {
			try {
				await b.writeFile(current, new Uint8Array(await blob.arrayBuffer()));
			} catch (e) {
				// No AuthExpiredError here on purpose. A desktop write fails because
				// the disk is full, the volume is unplugged or the file is locked by
				// another program - all transient, all resolved without the user
				// re-granting anything. Raising the reconnect gate would ask them to
				// re-pick a file that is exactly where they left it.
				throw new SelfstoreError('TARGET_WRITE_FAILED', `File write failed: ${String(e)}`);
			}
			return markerOf(b, current);
		},
		async load(): Promise<Blob | null> {
			try {
				const bytes = await b.readFile(current);
				return new Blob([new Uint8Array(bytes)]);
			} catch {
				// A path chosen through the save dialog names a file that does not
				// exist yet. "No backup there" is the honest answer, not a failure.
				return null;
			}
		},
		async stat(): Promise<string | null> {
			return markerOf(b, current);
		},
		async isReady(): Promise<boolean> {
			// A desktop write needs no user gesture and no grant that can lapse, so
			// the answer is yes even when the file is not there yet: refusing until
			// it exists would deadlock the very first save, which is what creates
			// it. A volume that went away surfaces when save() throws, and that
			// reads as transient - which is what an unplugged drive is.
			return true;
		},
		async reconnect(): Promise<boolean> {
			const picked = await b.save({ defaultPath: current, filters: FILTERS });
			if (!picked) return false;
			current = picked;
			await kv.set(PATH_KEY, picked);
			return true;
		},
		async disconnect(): Promise<void> {
			await kv.del(PATH_KEY);
		}
	};
}

export interface DesktopConnectOptions {
	/** Where the chosen path is persisted across launches. */
	kv: KV;
	/** Suggested name for the backup file. */
	fileName: string;
}

/** Ask for a file to write the backup to, and remember it. Null when the user
 *  cancelled, or when no shell is registered. */
export async function connect(opts: DesktopConnectOptions): Promise<BackupTarget | null> {
	if (!bridge) return null;
	const picked = await bridge.save({ defaultPath: opts.fileName, filters: FILTERS });
	if (!picked) return null;
	await opts.kv.set(PATH_KEY, picked);
	return fromPath(picked, bridge, opts.kv);
}

/** Ask for an EXISTING backup file and adopt it as the destination; the connect
 *  journey then reads it like any backup. Null when cancelled. */
export async function openExisting(opts: { kv: KV }): Promise<BackupTarget | null> {
	if (!bridge) return null;
	const picked = firstPath(await bridge.open({ multiple: false, filters: FILTERS }));
	if (!picked) return null;
	await opts.kv.set(PATH_KEY, picked);
	return fromPath(picked, bridge, opts.kv);
}

/** Rebuild the target from the path kept in a past launch, or null. Unlike the
 *  browser handle this needs no permission check, so a desktop app reopens on
 *  its file with nothing asked of the user. */
export async function fromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	if (!bridge) return null;
	const path = await opts.kv.get<string>(PATH_KEY);
	return path ? fromPath(path, bridge, opts.kv) : null;
}
