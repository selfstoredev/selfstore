/**
 * Disk-file backup target (Chromium only). The user picks a backup file once via
 * the File System Access API; the store then re-writes that real file on every
 * change. The handle is persisted through the injected KV, so the target stays
 * storage-agnostic. The browser re-confirms write permission once per session
 * (a one-click reconnect).
 */

import type { BackupTarget } from '../target';
import type { KV } from '../cache';
import { AuthExpiredError, SelfstoreError } from '../../selfstore';

const HANDLE_KEY = 'fileHandle';

interface FileHandle {
	name: string;
	createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
	getFile(): Promise<File>;
	queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
	requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface PickerWindow {
	showSaveFilePicker?: (o: {
		suggestedName?: string;
		types?: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileHandle>;
	showOpenFilePicker?: (o: {
		multiple?: boolean;
		types?: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileHandle[]>;
}

export interface FileConnectOptions {
	/** Where the picked file handle is persisted across sessions. */
	kv: KV;
	/** Suggested name for the backup file the user creates/picks. */
	fileName: string;
}

/** Set once a picker that EXISTS has refused to open. Presence is not
 *  capability: some browsers ship the methods and throw on call unless a flag
 *  is turned on, so a host that trusts `'showSaveFilePicker' in window` offers
 *  a file mode that can never work, and the button looks broken. The attempt is
 *  the only honest probe there is - it costs one click, once. */
let refused = false;

/** True when the browser supports picking a re-writable file (Chromium), and
 *  has not already refused to open one in this session. */
export function isSupported(): boolean {
	return !refused && typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/** Run a picker. Cancelling and refusing both mean "no file", but only a
 *  refusal says something about the browser - and it must not surface as an
 *  error, or the host reports a fault where it should offer another way. */
async function ask<T>(open: () => Promise<T>): Promise<T | null> {
	try {
		return await open();
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') return null; // user cancelled
		refused = true;
		return null;
	}
}

/** A revoked/denied file permission is a genuine loss of access: the store must
 *  raise the reconnect gate (one click re-grants). Everything else is transient. */
function isPermissionLoss(e: unknown): boolean {
	return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
}

function fromHandle(handle: FileHandle, kv: KV): BackupTarget {
	return {
		kind: 'file',
		label: handle.name,
		async save(blob: Blob): Promise<string | null> {
			try {
				const writable = await handle.createWritable();
				await writable.write(blob);
				await writable.close();
			} catch (e) {
				if (isPermissionLoss(e)) {
					throw new AuthExpiredError('File permission was revoked.');
				}
				throw new SelfstoreError('TARGET_WRITE_FAILED', `File write failed: ${String(e)}`);
			}
			try {
				// The file's new mtime = OUR write's version marker (shared-disk case).
				return String((await handle.getFile()).lastModified);
			} catch {
				return null;
			}
		},
		async load(): Promise<Blob | null> {
			return handle.getFile();
		},
		async stat(): Promise<string | null> {
			try {
				return String((await handle.getFile()).lastModified);
			} catch {
				return null; // permission not granted yet: "cannot tell", never throws
			}
		},
		async isReady(): Promise<boolean> {
			return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
		},
		async reconnect(): Promise<boolean> {
			return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
		},
		async disconnect(): Promise<void> {
			await kv.del(HANDLE_KEY);
		}
	};
}

/** Prompt the user to choose/create the backup file. Persists the handle for
 *  next sessions. Returns the target, or null if cancelled - or if the browser
 *  refused to open a picker at all, which `isSupported()` then reports. */
export async function connect(opts: FileConnectOptions): Promise<BackupTarget | null> {
	const picker = (window as unknown as PickerWindow).showSaveFilePicker;
	if (!picker) return null;
	const handle = await ask(() =>
		picker({
			suggestedName: opts.fileName,
			types: [{ description: 'Backup', accept: { 'application/zip': ['.zip'] } }]
		})
	);
	if (!handle) return null;
	await opts.kv.set(HANDLE_KEY, handle);
	return fromHandle(handle, opts.kv);
}

/** Prompt the user to pick an EXISTING backup file and adopt it as the
 *  destination (the connect journey then reads it like any backup: password,
 *  conflict, resume). Asks for readwrite up front so the first save does not
 *  stall on a second permission prompt. Returns null if cancelled. */
export async function openExisting(opts: { kv: KV }): Promise<BackupTarget | null> {
	const picker = (window as unknown as PickerWindow).showOpenFilePicker;
	if (!picker) return null;
	const picked = await ask(() =>
		picker({
			multiple: false,
			types: [{ description: 'Backup', accept: { 'application/zip': ['.zip'] } }]
		})
	);
	const handle = picked?.[0];
	if (!handle) return null;
	// Outside `ask`: a permission refusal here is about THIS file, not about the
	// browser. Marking the picker unsupported for it would strip the file mode
	// away from a browser that has just proved it works.
	if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return null;
	await opts.kv.set(HANDLE_KEY, handle);
	return fromHandle(handle, opts.kv);
}

/** Rebuild the target from the handle persisted in a past session, or null. */
export async function fromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	const handle = await opts.kv.get<FileHandle>(HANDLE_KEY);
	return handle ? fromHandle(handle, opts.kv) : null;
}
