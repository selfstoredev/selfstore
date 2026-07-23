// The contract every durable destination implements: disk file, Google Drive,
// WebDAV, or anything custom. A target is something the store can save() to
// silently, with no user gesture.
//
// Error protocol: throw AuthExpiredError for a genuine loss of access (session
// gone, permission withdrawn) - that raises the blocking reconnect gate. Any
// other throw reads as transient (offline, cold start, 5xx): the edit stays in
// the local cache and the next save or sync retries, no gate.

export type BuiltinTargetKind = 'file' | 'drive' | 'webdav';

/**
 * The two kinds the store keeps for itself: 'device' (cache-only) and
 * 'file-manual' (degraded download-on-demand). attachTarget refuses a target
 * claiming either - they name the absence of a target.
 */
export const RESERVED_STORE_MODES = ['device', 'file-manual'] as const;

/** Single source of truth for "is this kind a store mode, not a durable target". */
export function isReservedStoreMode(kind: string): boolean {
	return (RESERVED_STORE_MODES as readonly string[]).includes(kind);
}

/**
 * The read-only subset of BackupTarget a peer must provide. Any BackupTarget
 * satisfies it structurally; its save() is simply never called. Peer failures
 * follow the same protocol but are recorded per peer and never gate the store.
 */
export interface PeerSource {
	/** The peer's published copy, or null when none exists yet. */
	load(): Promise<Blob | null>;
	/** Cheap remote change marker, so unchanged copies can be skipped. Absent means "cannot tell". */
	stat?(): Promise<string | null>;
	/** Display name (defaults to the peer id). */
	readonly label?: string;
}

export interface BackupTarget {
	/** Stable discriminator, persisted and handed back to restoreTarget(kind)
	 *  next session. Custom targets pick any string outside the built-ins and
	 *  RESERVED_STORE_MODES. */
	readonly kind: string;
	/** Human label for the connected destination (file name, "Google Drive"). */
	readonly label: string;

	/** Push the backup blob. May resolve to the remote's new version marker
	 *  when the write reports it atomically (else the store calls stat()). */
	save(blob: Blob): Promise<string | null>;
	/** Latest backup blob, or null if none exists / unavailable. */
	load(): Promise<Blob | null>;
	/** Cheap remote change marker (Drive version, file mtime): lets the store
	 *  spot another replica's writes without downloading. */
	stat?(): Promise<string | null>;
	/** Writable right now, without a user gesture? False for a transient blip
	 *  (retried later); AuthExpiredError for a genuine loss of access. */
	isReady(): Promise<boolean>;
	/** Re-acquire access (needs a user gesture); resolves to whether it worked. */
	reconnect(): Promise<boolean>;
	/** Forget the target locally. Never deletes the remote data. */
	disconnect(): Promise<void>;
}
