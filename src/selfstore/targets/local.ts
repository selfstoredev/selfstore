/**
 * Local-disk helpers: the DOM edge of selfstore, kept out of the core so the
 * core stays environment-agnostic and testable.
 */

import { BACKUP_EXTENSION, BACKUP_MIME } from '../index';

/** The slice of FileSystemFileHandle this module needs. */
export interface SaveHandle {
	createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
}

/**
 * Ask the user where to save, and nothing else.
 *
 * Split out because ORDER decides whether the dialog opens at all. The picker
 * needs the transient user activation of the click, and that activation expires
 * while an encrypted backup is being built (Argon2id is deliberately slow). Ask
 * first, build after, and the dialog is still allowed; build first and the
 * browser refuses it. Hosts that saw a silent download instead of the save
 * dialog were hitting exactly that.
 *
 * Null when the browser has no picker at all (Firefox, Safari) or when it
 * refuses for any reason other than a cancellation - the caller then falls back
 * to a download. Throws nothing; a cancelled dialog is reported as CANCELLED.
 */
export async function pickSaveHandle(
	filename: string
): Promise<{ handle: SaveHandle } | 'CANCELLED' | null> {
	const picker = (
		window as unknown as {
			showSaveFilePicker?: (o: unknown) => Promise<SaveHandle>;
		}
	).showSaveFilePicker;
	if (!picker) return null;
	try {
		const handle = await picker({
			suggestedName: filename,
			types: [{ description: 'selfstore backup', accept: { [BACKUP_MIME]: [BACKUP_EXTENSION] } }]
		});
		return { handle };
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') return 'CANCELLED';
		// Anything else (no activation left, policy): the download still works.
		return null;
	}
}

/** Write a blob through a handle obtained earlier by pickSaveHandle. */
export async function writeToHandle(handle: SaveHandle, blob: Blob): Promise<void> {
	const writable = await handle.createWritable();
	await writable.write(blob);
	await writable.close();
}

/** Hand the blob to the browser's download machinery. No cancel to observe:
 *  once taken, the host has done all it can. */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/**
 * Save a backup blob to disk via the File System Access API, else a download.
 *
 * Resolves TRUE when bytes were handed to the browser, FALSE when the user
 * closed the save dialog. Callers must branch on it: a host that records "last
 * backup: today" after a cancelled dialog tells the user they are safe when no
 * file exists, and that lie only surfaces the day they need the file.
 *
 * Takes a ready blob, so the dialog opens only after the blob was built. When
 * that blob is an encrypted backup, prefer asking first: see pickSaveHandle.
 */
export async function saveToDisk(blob: Blob, filename: string): Promise<boolean> {
	const cible = await pickSaveHandle(filename);
	if (cible === 'CANCELLED') return false;
	if (cible) {
		await writeToHandle(cible.handle, blob);
		return true;
	}
	downloadBlob(blob, filename);
	return true;
}

/** Prompt the user to pick a backup file from disk. Resolves null if cancelled. */
export function pickFromDisk(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		// octet-stream: some providers serve a downloaded ZIP under that type.
		input.accept = '.zip,application/zip,application/octet-stream';
		input.onchange = () => resolve(input.files?.[0] ?? null);
		// Without this, a cancelled dialog leaves the promise pending forever.
		input.oncancel = () => resolve(null);
		// Some browsers need the input in the DOM for the dialog to open.
		input.style.display = 'none';
		document.body.appendChild(input);
		input.click();
		input.remove();
	});
}
