/**
 * selfstore/sync - the bare multi-device merge engine.
 *
 * Field-level last-writer-wins over hybrid logical clocks, deletions as
 * tombstones, no CRDT runtime and no storage opinion: stamp() records what
 * changed, merge() reconciles two replicas, detectConflicts() surfaces
 * concurrent edits for optional review. The stores (package root and
 * 'selfstore/advanced') run this for you; import it directly only to embed
 * the algorithm in your own persistence. Format details: SYNC.md in the
 * repository.
 */

export {
	createNode,
	stamp,
	merge,
	createMeta,
	changes,
	detectConflicts,
	type Hlc,
	type SyncConfig,
	type SyncMeta,
	type ColMeta,
	type MergeStrategy,
	type Conflict,
	type MergeResult,
	type ReplicaState,
	type CollectionChanges,
	type Id
} from '../sync';
