/**
 * Implement a BackupTarget over any blob store - here a Map standing in for an
 * S3 bucket or a KV namespace. A custom target may use any `kind` string except
 * the reserved store modes ('device', 'file-manual'). The store then persists
 * and restores it like a built-in.
 */
import { AuthExpiredError, type BackupTarget } from '../src/entries/advanced';

export function bucketTarget(bucket: Map<string, Blob>, key: string): BackupTarget {
	return {
		kind: 's3',
		label: `bucket:${key}`,
		async save(blob: Blob): Promise<string | null> {
			bucket.set(key, blob);
			return null; // no version marker; the store falls back to stat() (omitted here)
		},
		async load(): Promise<Blob | null> {
			return bucket.get(key) ?? null;
		},
		async isReady(): Promise<boolean> {
			// Return false for a transient blip (auto-retried); THROW AuthExpiredError
			// for a genuine loss of access, which raises the store's reconnect gate.
			return true;
		},
		async reconnect(): Promise<boolean> {
			return true;
		},
		async disconnect(): Promise<void> {
			// Forget locally; never delete the remote object.
		},
	};
}

/** How a real target signals that access is genuinely gone (vs a transient blip). */
export function refuse(): never {
	throw new AuthExpiredError('bucket credentials were revoked');
}
