// The inner archive: a JSON manifest (selfstore.json) plus one entry per
// binary file, as a plain ZIP. Encrypted backups wrap these same bytes in
// AES-GCM (box.ts). fflate is imported dynamically - only needed at
// export/import time.

import type { Snapshot, SnapshotFile } from './types';
import { SelfstoreError } from './errors';

const MANIFEST = 'selfstore.json';
// Opaque caller bookkeeping (createLocalStore's schema version + merge
// metadata). Its own entry, so the manifest holds nothing but app data.
const SIDECAR = 'sync.json';
const ARCHIVE_VERSION = 1;

// Zip-bomb guards. Backups are user data measured in MB; half a GiB per
// entry and 1 GiB total are far above legitimate use and bound worst-case
// inflation (many individually-legal entries must not add up to a bomb).
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

interface FileMeta {
	id: string;
	name: string;
	mime: string;
}

/**
 * ZIP a set of named entries. `level` applies to the JSON entries; file
 * attachments are stored uncompressed - photos and PDFs are usually already
 * compressed, and re-deflating them was the biggest chunk of per-save
 * main-thread time for near-zero size gain. Still a plain readable ZIP.
 */
export async function zip(
	entries: Record<string, Uint8Array>,
	level: 0 | 6 = 6
): Promise<Uint8Array> {
	const { zipSync } = await import('fflate');
	const input: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
	for (const [name, bytes] of Object.entries(entries)) {
		input[name] = level !== 0 && name.startsWith('files/') ? [bytes, { level: 0 }] : bytes;
	}
	return zipSync(input as Parameters<typeof zipSync>[0], { level });
}

/** Unzip to named entries. BAD_FORMAT on unreadable bytes, TOO_LARGE past the bomb guards. */
export async function unzip(
	bytes: Uint8Array,
	maxEntryBytes: number = MAX_ENTRY_BYTES,
	maxTotalBytes: number = MAX_TOTAL_BYTES
): Promise<Record<string, Uint8Array>> {
	const { unzipSync } = await import('fflate');
	let total = 0;
	try {
		return unzipSync(bytes, {
			filter: (f) => {
				if (f.originalSize > maxEntryBytes) {
					throw new SelfstoreError('TOO_LARGE', `Archive entry "${f.name}" is too large.`);
				}
				total += f.originalSize;
				if (total > maxTotalBytes) {
					throw new SelfstoreError('TOO_LARGE', 'Archive total size exceeds the guard.');
				}
				return true;
			}
		});
	} catch (e) {
		if (e instanceof SelfstoreError) throw e;
		throw new SelfstoreError('BAD_FORMAT', 'Unreadable archive.');
	}
}

/** Manifest + file entries for a snapshot; `sidecar` rides its own sync.json entry. */
export function buildEntries(snap: Snapshot, sidecar?: unknown): Record<string, Uint8Array> {
	const entries: Record<string, Uint8Array> = {};
	entries[MANIFEST] = utf8.enc.encode(
		JSON.stringify({
			version: ARCHIVE_VERSION,
			collections: snap.collections,
			files: snap.files.map(({ id, name, mime }): FileMeta => ({ id, name, mime }))
		})
	);
	if (sidecar !== undefined && sidecar !== null) {
		entries[SIDECAR] = utf8.enc.encode(JSON.stringify(sidecar));
	}
	for (const f of snap.files) entries[`files/${f.id}`] = f.bytes;
	return entries;
}

/** The sync.json sidecar if present, else null. Unreadable content reads as absent. */
export function readSidecar(entries: Record<string, Uint8Array>): unknown {
	const bytes = entries[SIDECAR];
	if (!bytes) return null;
	try {
		return JSON.parse(utf8.dec.decode(bytes));
	} catch {
		return null;
	}
}

/** Rebuild a snapshot from ZIP entries (the inverse of buildEntries). */
export function entriesToSnapshot(entries: Record<string, Uint8Array>): Snapshot {
	const manifestBytes = entries[MANIFEST];
	if (!manifestBytes) throw new SelfstoreError('BAD_FORMAT', 'Missing manifest.');
	const manifest = JSON.parse(utf8.dec.decode(manifestBytes)) as {
		collections?: Record<string, unknown[]>;
		files?: FileMeta[];
	};
	const files: SnapshotFile[] = (manifest.files ?? []).map((m) => ({
		...m,
		bytes: entries[`files/${m.id}`] ?? new Uint8Array()
	}));
	return { collections: manifest.collections ?? {}, files };
}

/** Pack a snapshot (plus an optional opaque sidecar) into ZIP bytes. */
export async function pack(snap: Snapshot, sidecar?: unknown): Promise<Uint8Array> {
	return zip(buildEntries(snap, sidecar), 6);
}

/** Unpack ZIP bytes into a snapshot plus its sidecar (null when absent). */
export async function unpackWithSidecar(
	zipBytes: Uint8Array
): Promise<{ snapshot: Snapshot; sidecar: unknown }> {
	const entries = await unzip(zipBytes);
	return { snapshot: entriesToSnapshot(entries), sidecar: readSidecar(entries) };
}
