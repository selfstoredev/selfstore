/**
 * Convergent, schema-agnostic merge for offline-first apps. Two pure calls:
 * `stamp(meta, collections, config)` after each local change, and
 * `merge(local, remote, config)` on sync. Declare each collection's strategy
 * once; the engine keeps your data plain JSON, with no CRDT runtime.
 */

export { createNode, type Hlc } from './hlc';
export {
	stamp,
	merge,
	detectConflicts,
	createMeta,
	changes,
	gcTombstones,
	unsyncableCounts,
	idPathFor,
	type SyncConfig,
	type SyncMeta,
	type ColMeta,
	type MergeStrategy,
	type Conflict,
	type MergeResult,
	type ReplicaState,
	type CollectionChanges,
	type Id
} from './merge';
