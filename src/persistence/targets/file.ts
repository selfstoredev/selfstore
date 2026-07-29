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
import * as desktop from './desktop';

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

/** Was the call made inside a live user gesture?
 *
 * A picker REQUIRES transient activation, and a call made without one throws
 * the same DOMException as a browser that ships the picker and refuses it. Read
 * as a refusal, one mistimed call condemns the file mode for the whole session:
 * the host then falls back to manual downloads on a Chrome that was never
 * asked properly. A throw only teaches us about the browser when the browser
 * was actually allowed to answer. Undefined support (no userActivation) reads
 * as "cannot tell" - and cannot-tell must not accuse. */
function insideGesture(): boolean {
	const ua = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
	return ua ? ua.isActive : true;
}

/** True when a re-writable file can be picked: a registered desktop shell, or
 *  a browser that ships the File System Access API (Chromium) and has not
 *  already refused to open a picker in this session.
 *
 *  A desktop shell answers first and unconditionally. Inside a native webview
 *  the browser probe is not merely negative, it is misleading: WebKit never
 *  shipped the API, so the honest capability there is the shell's, and asking
 *  the webview instead would degrade the file mode in the one environment where
 *  writing a real file is easiest. */
export function isSupported(): boolean {
	if (desktop.hasDesktopFiles()) return true;
	return !refused && typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/** True when the browser can let the user point at an EXISTING file. Hosts must
 *  gate that gesture on this: unlike creating, it has no download fallback, so
 *  offering it where it cannot run leaves a button that answers nothing. The
 *  refusal is shared with `isSupported` - a browser that refuses one picker
 *  refuses the family. */
export function isOpenSupported(): boolean {
	if (desktop.hasDesktopFiles()) return true;
	return !refused && typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

/** Run a picker. Cancelling and refusing both mean "no file", but only a
 *  refusal says something about the browser - and it must not surface as an
 *  error, or the host reports a fault where it should offer another way. */
async function ask<T>(open: () => Promise<T>): Promise<T | null> {
	const asked = insideGesture();
	try {
		return await open();
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') return null; // user cancelled
		// Outside a gesture the browser refused the CALL, not the feature: keep
		// the file mode intact so the host can ask again from a real click.
		refused = asked;
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
	if (desktop.hasDesktopFiles()) return desktop.connect(opts);
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
 *  conflict, resume). Tries to raise the grant to readwrite up front so the
 *  first save does not stall on a second prompt. Returns null if cancelled. */
export async function openExisting(opts: { kv: KV }): Promise<BackupTarget | null> {
	if (desktop.hasDesktopFiles()) return desktop.openExisting(opts);
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
	// The upgrade to readwrite is a COURTESY, not a condition. It can fail for a
	// reason that has nothing to do with the file - the open picker consumes the
	// transient activation a permission prompt needs, so a browser may answer
	// 'prompt' without ever asking anyone. Throwing the picked file away then
	// dropped the host back on its own screen with nothing said and nothing
	// changed: the user pointed at their file and the app appeared to ignore it.
	// So we adopt it either way. Reading works on the grant the picker gave, and
	// a write that cannot happen raises the store's own reconnect gate, whose
	// one click re-asks from inside a real gesture - the only place it can work.
	// Outside `ask`: a refusal here is about THIS file, never about the picker,
	// which has just proved it opens.
	try {
		await handle.requestPermission({ mode: 'readwrite' });
	} catch {
		/* no prompt was possible: the reconnect gesture will ask for real */
	}
	await opts.kv.set(HANDLE_KEY, handle);
	return fromHandle(handle, opts.kv);
}

/** Rebuild the target from what a past session persisted, or null. On a desktop
 *  shell that is a path and it reconnects silently; in a browser it is a handle
 *  and the first write may still ask for the permission back. */
export async function fromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	if (desktop.hasDesktopFiles()) return desktop.fromSession(opts);
	const handle = await opts.kv.get<FileHandle>(HANDLE_KEY);
	return handle ? fromHandle(handle, opts.kv) : null;
}
