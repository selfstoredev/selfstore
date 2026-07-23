/**
 * Google Drive backup target. Does the Drive REST file operations (find-or-create,
 * upload, download) for a single backup file. It only ships bytes; the store
 * decides whether they are encrypted. How an access token is obtained (a browser
 * OAuth flow, a backend broker, ...) is injected via DriveAuth, so this target
 * stays free of any specific auth strategy or backend.
 *
 * Beyond the standard connect/fromSession lifecycle, this module exposes
 * shared-file primitives (preview, adopt, findOrCreateOwnFile) for apps whose
 * users point several devices - or several people - at one Drive-hosted backup
 * file: preview it read-only, then adopt it as this device's backup.
 */

import type { BackupTarget } from '../target';
import type { KV } from '../cache';
import { AuthExpiredError, SelfstoreError, isAuthExpired } from '../../selfstore';

/** KV key holding the connected backup's Drive file id. Public because app-level
 *  flows that operate on the same file (e.g. sharing it) need to read it. */
export const FILE_ID_KEY = 'driveFileId';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** A hung request must not spin forever behind a dead connection - the very
 *  "long moment trying to connect" a stuck backup shows. A deadline turns the
 *  hang into an ordinary error (transient: the store retries), never a gate.
 *  Data transfers get more room than metadata pokes. AbortSignal.timeout is
 *  minted per fetch (a fired signal cannot be reused across driveFetch's retry). */
const DATA_DEADLINE_MS = 30_000;
const META_DEADLINE_MS = 15_000;

/** How the target gets access. Injected, so the auth strategy lives in the app.
 *  Error protocol: a genuine loss of access (the session is gone, re-consent
 *  needed) must throw AuthExpiredError - or any error with code 'AUTH_EXPIRED' -
 *  while a transient offline/cold-start failure throws a plain error, so the
 *  store retries it instead of raising the reconnect gate. */
export interface DriveAuth {
	/** A fresh access token, or throw if access must be re-established. Pass
	 *  `{ forceRefresh: true }` to bypass any cached token and mint a new one:
	 *  the target calls this after a 401 to tell a merely STALE token (a refresh
	 *  fixes it, no gate) from a genuinely lost session (the refresh 401s too).
	 *  An implementation that cannot force a refresh may ignore the flag; the
	 *  target then retries with the same token, no worse than before. */
	token(opts?: { forceRefresh?: boolean }): Promise<string>;
	/** Re-establish access with a user gesture; resolves to whether it worked. */
	reconnect(): Promise<boolean>;
	/** Forget the connection, locally and server-side. */
	forget(): Promise<void>;
}

/** Run a Drive request; if Google answers 401 the access token may just be
 *  STALE (rejected before its nominal expiry - rotation, an early revoke), so
 *  force a fresh token and try once more. Only a SECOND 401 means the session
 *  is genuinely gone. This is what stops a stale-token blip - common when a
 *  flow makes many Drive calls, e.g. group-mode republishing every converge -
 *  from raising the blocking reconnect gate over a still-valid connection. */
async function driveFetch(
	auth: DriveAuth,
	run: (token: string) => Promise<Response>
): Promise<Response> {
	const r = await run(await auth.token());
	if (r.status !== 401) return r;
	return run(await auth.token({ forceRefresh: true }));
}

export interface DriveOptions {
	auth: DriveAuth;
	kv: KV;
	/** Name of the backup file created in the user's Drive. */
	fileName: string;
}

async function findExistingFile(token: string, fileNames: string[]): Promise<string | null> {
	for (const name of fileNames) {
		// 'me' in owners: a shared backup carries the same name but lives on someone
		// else's Drive - only an OWNED file may be (re)connected as the personal
		// backup, or a fresh connect could silently re-adopt theirs.
		// Escape the name for Drive's query grammar (backslash then single-quote):
		// a name carrying a quote must not break out of the `name='...'` clause and
		// alter the filter (encodeURIComponent handles transport, not query syntax).
		const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		const q = encodeURIComponent(`name='${safe}' and trashed=false and 'me' in owners`);
		const r = await fetch(`${DRIVE_FILES}?q=${q}&fields=files(id)&pageSize=1`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(META_DEADLINE_MS)
		});
		if (!r.ok) continue;
		const data: { files?: { id: string }[] } = await r.json();
		const id = data.files?.[0]?.id;
		if (id) return id;
	}
	return null;
}

/** Classify a non-OK Drive write we could not otherwise handle (the 401 case is
 *  the caller's). A 404 - the bound file is gone (deleted, trashed, id no longer
 *  valid) - or a 403 that is not a rate limit (permission withdrawn, storage
 *  full) is PERMANENT: retrying writes the same doomed request forever (the
 *  silent "momentarily unreachable" trap), so the store must raise its gate and
 *  let the user reconnect to a fresh file or free space. A 403 rate limit and
 *  everything else (5xx, network) stay transient. The body carries Drive's
 *  `reason` (e.g. userRateLimitExceeded vs storageQuotaExceeded); absent, a bare
 *  403 is treated as permanent (the safer default - a real rate limit names
 *  itself). */
function isPermanentDriveWrite(status: number, body: string): boolean {
	if (status === 404) return true;
	if (status === 403) return !/ratelimit|dailylimit/i.test(body);
	return false;
}

async function createFile(token: string, fileName: string): Promise<string> {
	const boundary = 'SLFS_BOUNDARY';
	const meta = JSON.stringify({ name: fileName, mimeType: 'application/octet-stream' });
	const body = [
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
		meta,
		`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--`
	].join('');
	const r = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': `multipart/related; boundary=${boundary}`
		},
		body,
		signal: AbortSignal.timeout(META_DEADLINE_MS)
	});
	if (!r.ok) throw new SelfstoreError('TARGET_WRITE_FAILED', `Drive create failed: ${r.status}`);
	const data: { id: string } = await r.json();
	return data.id;
}

function makeTarget(opts: DriveOptions, fixedId?: string): BackupTarget {
	const { auth, kv } = opts;
	// A target is BOUND to one file for its whole life: the id is the fixed one,
	// or the remembered id CAPTURED on first use - never re-read per operation.
	// The old lazy per-call read let a backup SWITCH re-point the remembered id
	// while the OUTGOING target was still attached: its final courtesy flush
	// then wrote the old store (data and sync bookkeeping) into the file being
	// opened, silently merging two "isolated" backups.
	let captured: string | undefined = fixedId;
	const fileIdOf = async (): Promise<string | undefined> =>
		(captured ??= await kv.get<string>(FILE_ID_KEY));
	return {
		kind: 'drive',
		label: 'Google Drive',
		async save(blob: Blob): Promise<string | null> {
			const fileId = await fileIdOf();
			if (!fileId) throw new SelfstoreError('NOT_CONNECTED', 'Drive not connected.');
			// fields=version: the response reports the file's new version, so the
			// store records exactly OUR write (no marker race with other replicas).
			const r = await driveFetch(auth, (token) =>
				fetch(`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=version`, {
					method: 'PATCH',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
					body: blob,
					signal: AbortSignal.timeout(DATA_DEADLINE_MS)
				})
			);
			if (!r.ok) {
				// A 401 that survives a forced token refresh (driveFetch) is a genuine
				// loss of access, not a stale-token blip. A 404 (the bound file is
				// gone) or a non-rate-limit 403 (permission withdrawn, storage full) is
				// PERMANENT: gate so the user reconnects to a fresh file, never loop it
				// as transient. Everything else (5xx, network) stays transient.
				if (r.status === 401) throw new AuthExpiredError('Drive rejected the token (401).');
				const body = await r.text().catch(() => '');
				if (isPermanentDriveWrite(r.status, body)) {
					throw new SelfstoreError(
						'TARGET_GONE',
						`Drive backup unwritable (${r.status}): the file is gone or access was withdrawn.`
					);
				}
				throw new SelfstoreError('TARGET_WRITE_FAILED', `Drive upload failed: ${r.status}`);
			}
			try {
				const data: { version?: string | number } = await r.json();
				return data.version != null ? String(data.version) : null;
			} catch {
				return null;
			}
		},
		async load(): Promise<Blob | null> {
			const fileId = await fileIdOf();
			if (!fileId) return null;
			const r = await driveFetch(auth, (token) =>
				fetch(`${DRIVE_FILES}/${fileId}?alt=media`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(DATA_DEADLINE_MS)
				})
			);
			// A failed read must never pass for an empty file: null tells the store
			// "nothing there", and a fresh connect would then overwrite the backup
			// this download merely failed to fetch. Only a 404 - the file is
			// genuinely gone - reads as empty; a 401 that survived driveFetch's
			// forced refresh is a real loss of access; anything else is a typed
			// transient failure (the sync legs retry it, connect flows surface it).
			if (r.status === 404) return null;
			if (r.status === 401) throw new AuthExpiredError('Drive rejected the token (401).');
			if (!r.ok) {
				throw new SelfstoreError('TARGET_UNAVAILABLE', `Drive download failed: ${r.status}`);
			}
			return r.blob();
		},
		async stat(): Promise<string | null> {
			try {
				const fileId = await fileIdOf();
				if (!fileId) return null;
				const r = await driveFetch(auth, (token) =>
					fetch(`${DRIVE_FILES}/${fileId}?fields=version`, {
						headers: { Authorization: `Bearer ${token}` },
						signal: AbortSignal.timeout(META_DEADLINE_MS)
					})
				);
				if (!r.ok) return null;
				const data: { version?: string | number } = await r.json();
				return data.version != null ? String(data.version) : null;
			} catch {
				return null; // offline or token lapse: "cannot tell", never throws
			}
		},
		async isReady(): Promise<boolean> {
			try {
				await auth.token();
				return true;
			} catch (e) {
				// A transient token failure means "not writable right now", not a lost
				// session: report false so the store retries. Only a genuine auth loss
				// propagates, so the boot path can raise the reconnect gate.
				if (isAuthExpired(e)) throw e;
				return false;
			}
		},
		async reconnect(): Promise<boolean> {
			return auth.reconnect();
		},
		async disconnect(): Promise<void> {
			await auth.forget();
			// Delete the remembered id only while it still points at this target's
			// file: after a backup switch the key already belongs to the new
			// target, and a late disconnect of the old one must not orphan it.
			const current = await kv.get<string>(FILE_ID_KEY);
			const own = await fileIdOf();
			if (!current || !own || current === own) await kv.del(FILE_ID_KEY);
		}
	};
}

/** First-time connect: authorize (a user gesture), then find-or-create the file.
 *  Returns the target, or null if the user cancelled the consent. */
export async function connect(opts: DriveOptions): Promise<BackupTarget | null> {
	if (!(await opts.auth.reconnect())) return null;
	const token = await opts.auth.token();
	let fileId = await opts.kv.get<string>(FILE_ID_KEY);
	if (!fileId) {
		fileId =
			(await findExistingFile(token, [opts.fileName])) ?? (await createFile(token, opts.fileName));
		await opts.kv.set(FILE_ID_KEY, fileId);
	}
	return makeTarget(opts);
}

/** Rebuild the target from a past session's saved connection (no UI), or null. */
export async function fromSession(opts: DriveOptions): Promise<BackupTarget | null> {
	return (await opts.kv.get<string>(FILE_ID_KEY)) ? makeTarget(opts) : null;
}

/** A read-only-intent preview of one specific (typically shared) file, before
 *  adopting it. Writes NOTHING to the KV: until the user confirms, the device's
 *  own backup wiring must stay untouched. */
export function preview(opts: DriveOptions, fileId: string): BackupTarget {
	return makeTarget(opts, fileId);
}

/** Adopt a specific (typically shared) file as this device's backup. Persists
 *  the file id, so next sessions restore it like any Drive backup. */
export async function adopt(opts: DriveOptions, fileId: string): Promise<BackupTarget> {
	await opts.kv.set(FILE_ID_KEY, fileId);
	return makeTarget(opts);
}

/** Find (or create) the user's own backup file, ignoring the currently adopted
 *  id (which may point at someone else's shared file). Reuses the live session
 *  when possible and only falls back to the consent popup. Adopts NOTHING: the
 *  caller decides whether to load the file or start it blank. Null when the
 *  consent is refused. */
export async function findOrCreateOwnFile(
	opts: DriveOptions
): Promise<{ fileId: string; created: boolean } | null> {
	let token: string;
	try {
		token = await opts.auth.token();
	} catch {
		if (!(await opts.auth.reconnect())) return null;
		token = await opts.auth.token();
	}
	const existing = await findExistingFile(token, [opts.fileName]);
	if (existing) return { fileId: existing, created: false };
	return { fileId: await createFile(token, opts.fileName), created: true };
}

/** One row of `listBackups()`: what Drive reports about a file the app can
 *  see. Whether the backup is encrypted is not here on purpose - that lives
 *  inside the file (inspect it, or remember it app-side); a listing must stay
 *  one cheap metadata call, never N downloads. */
export interface DriveBackupInfo {
	id: string;
	name: string;
	/** RFC 3339 timestamp of the last write, as Drive reports it. */
	modifiedTime: string | null;
	/** Size in bytes, when Drive reports one. */
	size: number | null;
}

/** List the files this app can see on the user's own Drive (the drive.file
 *  scope already narrows visibility to files the app created or was handed).
 *  `nameContains` narrows server-side; selfstore ships no naming convention -
 *  the app applies its own exact rules on what comes back (its backups, its
 *  internal files). Newest first. */
export async function listBackups(opts: {
	auth: DriveAuth;
	nameContains?: string;
}): Promise<DriveBackupInfo[]> {
	const clauses = ["trashed=false", "'me' in owners"];
	if (opts.nameContains) {
		const safe = opts.nameContains.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		clauses.push(`name contains '${safe}'`);
	}
	const q = encodeURIComponent(clauses.join(' and '));
	const fields = encodeURIComponent('files(id,name,modifiedTime,size)');
	const r = await driveFetch(opts.auth, (token) =>
		fetch(`${DRIVE_FILES}?q=${q}&fields=${fields}&pageSize=100&orderBy=modifiedTime%20desc`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(META_DEADLINE_MS)
		})
	);
	if (r.status === 401) throw new AuthExpiredError('Drive rejected the token (401).');
	if (!r.ok) throw new SelfstoreError('TARGET_UNAVAILABLE', `Drive list failed: ${r.status}`);
	const data: {
		files?: { id: string; name: string; modifiedTime?: string; size?: string | number }[];
	} = await r.json();
	return (data.files ?? []).map((f) => ({
		id: f.id,
		name: f.name,
		modifiedTime: f.modifiedTime ?? null,
		size: f.size != null ? Number(f.size) : null
	}));
}

/** Create a brand-new empty backup file with this exact name and answer its
 *  id. Refuses when a non-trashed owned file already carries the name: Drive
 *  happily stores duplicate names, and a duplicate would poison every
 *  find-by-name reconnect that follows. Adopts nothing - the caller decides
 *  to attach it (typically with `wipe: true` so it starts blank). */
export async function createBackup(opts: {
	auth: DriveAuth;
	fileName: string;
}): Promise<{ fileId: string }> {
	const token = await opts.auth.token();
	const existing = await findExistingFile(token, [opts.fileName]);
	if (existing) {
		throw new SelfstoreError(
			'TARGET_WRITE_FAILED',
			`A file named "${opts.fileName}" already exists on Drive.`
		);
	}
	return { fileId: await createFile(token, opts.fileName) };
}

/** Delete a backup file from Drive, for good (not the trash: the file's data
 *  must actually be gone, not lingering). A 404 is success - deleting what is
 *  already gone is not an error. The caller owns the guard against deleting
 *  the currently attached file. */
export async function deleteBackup(opts: { auth: DriveAuth; fileId: string }): Promise<void> {
	const r = await driveFetch(opts.auth, (token) =>
		fetch(`${DRIVE_FILES}/${opts.fileId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(META_DEADLINE_MS)
		})
	);
	if (r.status === 401) throw new AuthExpiredError('Drive rejected the token (401).');
	if (r.status === 404) return;
	if (!r.ok) throw new SelfstoreError('TARGET_WRITE_FAILED', `Drive delete failed: ${r.status}`);
}

/** Rename a backup file (metadata only - the id, the content and every open
 *  target bound to it are untouched). Refuses when another owned file already
 *  carries the new name, for the same reason createBackup does: a duplicate
 *  poisons find-by-name. A 404 means the file is gone, not a success here. */
export async function renameBackup(opts: {
	auth: DriveAuth;
	fileId: string;
	fileName: string;
}): Promise<void> {
	const token = await opts.auth.token();
	const existing = await findExistingFile(token, [opts.fileName]);
	if (existing && existing !== opts.fileId) {
		throw new SelfstoreError(
			'TARGET_WRITE_FAILED',
			`A file named "${opts.fileName}" already exists on Drive.`
		);
	}
	if (existing === opts.fileId) return; // already this name: nothing to do
	const r = await driveFetch(opts.auth, (token) =>
		fetch(`${DRIVE_FILES}/${opts.fileId}?fields=id`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: opts.fileName }),
			signal: AbortSignal.timeout(META_DEADLINE_MS)
		})
	);
	if (r.status === 401) throw new AuthExpiredError('Drive rejected the token (401).');
	if (!r.ok) throw new SelfstoreError('TARGET_WRITE_FAILED', `Drive rename failed: ${r.status}`);
}
