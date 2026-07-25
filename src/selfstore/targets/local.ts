/**
 * Local-disk helpers: the DOM edge of selfstore, kept out of the core so the
 * core stays environment-agnostic and testable.
 */

import { BACKUP_EXTENSION, BACKUP_MIME } from '../index';

/**
 * Save a backup blob to disk via the File System Access API, else a download.
 *
 * Resolves TRUE when bytes were handed to the browser, FALSE when the user
 * closed the save dialog. Callers must branch on it: a host that records "last
 * backup: today" after a cancelled dialog tells the user they are safe when no
 * file exists, and that lie only surfaces the day they need the file.
 */
export async function saveToDisk(blob: Blob, filename: string): Promise<boolean> {
	const picker = (
		window as unknown as {
			showSaveFilePicker?: (o: unknown) => Promise<{
				createWritable: () => Promise<{
					write: (d: Blob) => Promise<void>;
					close: () => Promise<void>;
				}>;
			}>;
		}
	).showSaveFilePicker;

	if (picker) {
		try {
			const handle = await picker({
				suggestedName: filename,
				types: [{ description: 'selfstore backup', accept: { [BACKUP_MIME]: [BACKUP_EXTENSION] } }]
			});
			const writable = await handle.createWritable();
			await writable.write(blob);
			await writable.close();
			return true;
		} catch (e) {
			// Cancelled picker: say so. Any other error falls through to download.
			if (e instanceof DOMException && e.name === 'AbortError') return false;
		}
	}

	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	// A download has no cancel to observe: once the browser takes the blob, the
	// host has done everything it can.
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
