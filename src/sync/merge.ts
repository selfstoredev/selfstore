/**
 * Schema-agnostic convergent merge for plain JSON. It keeps a small sidecar of
 * metadata (one logical clock per record) and reconciles two replica states with
 * well-known set semantics. Documents stay plain objects: identity is a
 * configured id field, change detection is by content hash, nothing is injected.
 *
 * Per-collection strategy:
 *   'lww-set'      records keyed by id; later write per id wins; deletes tombstoned.
 *   'lww-map'      records keyed by id, merged field BY field: concurrent edits
 *                  to different fields of one record both survive; the same field
 *                  goes to the later clock. Deletes stay record-level.
 *   'grow-set'     append-only; entries immutable; union, never a conflict.
 *   'lww-register' a single value; later write wins.
 *   'manual'       surface concurrent edits to the same id instead of resolving.
 *
 * For collaborative rich text, store an Automerge/Yjs document as a binary file
 * in the snapshot instead; this engine stops short of sequence CRDTs.
 */

import { type Hlc, issue, max, compare, createNode, hlcWall } from './hlc';

export type { Hlc } from './hlc';
export type Id = string;
export type MergeStrategy = 'lww-set' | 'lww-map' | 'grow-set' | 'lww-register' | 'manual';

export interface SyncConfig {
	/** Field holding each record's stable id (default 'id'). Dot-notation allowed. */
	idField?: string;
	/** Per-collection id path override for records whose id is not at the top level. */
	ids?: Record<string, string>;
	/** Strategy per collection name; anything unlisted uses `fallback`. */
	strategies?: Record<string, MergeStrategy>;
	/** Strategy for unlisted collections (default 'lww-set'). */
	fallback?: MergeStrategy;
}

/** Sidecar metadata for one collection, keyed by record id. */
export interface ColMeta {
	clocks: Record<Id, Hlc>;
	deleted: Record<Id, Hlc>;
	hashes: Record<Id, number>;
	/** 'lww-map' only: per-field [clock, contentHash], so concurrent edits to
	 *  different fields of one record merge instead of one side losing. */
	fields?: Record<Id, Record<string, [Hlc, number]>>;
}

/** Everything one replica tracks. Travels with the data so the other side can merge. */
export interface SyncMeta {
	node: string;
	clock: Hlc | null;
	cols: Record<string, ColMeta>;
}

/** A same-id concurrent edit the 'manual' strategy refused to auto-resolve.
 *  `local`/`remote` carry the two full versions during the session; consumers
 *  persisting conflicts (e.g. the store's journal) redact them, so they are
 *  absent after a reload - never write user records to unencrypted storage. */
export interface Conflict {
	collection: string;
	id: Id;
	local?: unknown;
	remote?: unknown;
	/** The side kept as the provisional value (so it still converges). */
	kept: 'local' | 'remote';
}

export interface MergeResult {
	collections: Record<string, unknown[]>;
	meta: SyncMeta;
	conflicts: Conflict[];
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
	const o = v as Record<string, unknown>;
	return (
		'{' +
		Object.keys(o)
			.sort()
			.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
			.join(',') +
		'}'
	);
}

/** FNV-1a 32-bit hash, enough to detect that a record changed. */
function hash(v: unknown): number {
	const s = stableStringify(v);
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function emptyCol(): ColMeta {
	return { clocks: {}, deleted: {}, hashes: {} };
}

function cloneCol(c: ColMeta | undefined): ColMeta {
	if (!c) return emptyCol();
	const out: ColMeta = {
		clocks: { ...c.clocks },
		deleted: { ...c.deleted },
		hashes: { ...c.hashes }
	};
	if (c.fields) {
		out.fields = {};
		for (const [id, f] of Object.entries(c.fields)) out.fields[id] = { ...f };
	}
	return out;
}

function strategyOf(config: SyncConfig, collection: string): MergeStrategy {
	return config.strategies?.[collection] ?? config.fallback ?? 'lww-set';
}

function idOf(config: SyncConfig, collection: string, doc: unknown): Id | null {
	const path = config.ids?.[collection] ?? config.idField ?? 'id';
	let v: unknown = doc;
	for (const key of path.split('.')) {
		if (v === null || typeof v !== 'object') return null;
		v = (v as Record<string, unknown>)[key];
	}
	return typeof v === 'string' ? v : null;
}

/** The id path this config resolves for a collection (for diagnostics). */
export function idPathFor(config: SyncConfig, collection: string): string {
	return config.ids?.[collection] ?? config.idField ?? 'id';
}

/** Records the engine cannot track because they have no string id at the
 *  configured path. Identity is a string id field, so such a record is invisible
 *  to stamp/merge - it would silently never replicate. Returns the count per
 *  collection (nonzero entries only), for a dev-time warning. A number or missing
 *  id is the classic footgun: give each record a string id, or map the field via
 *  `sync.ids`. */
export function unsyncableCounts(
	collections: Record<string, unknown[]>,
	config: SyncConfig = {}
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [name, docs] of Object.entries(collections)) {
		let n = 0;
		for (const doc of docs ?? []) if (idOf(config, name, doc) === null) n++;
		if (n > 0) out[name] = n;
	}
	return out;
}

export function createMeta(node: string = createNode()): SyncMeta {
	return { node, clock: null, cols: {} };
}

/**
 * Prune tombstones (delete markers) whose clock is older than `beforeWall` (a
 * wall-time ms cutoff, e.g. `Date.now() - horizon`). Tombstones otherwise
 * accumulate forever, since a delete must be remembered to out-vote a stale
 * replica still holding the record.
 *
 * Safe only when the cutoff is older than the longest a replica can stay offline
 * before it next syncs: a replica that never saw a delete, and whose tombstone
 * has been GC'd everywhere, will resurrect that record on its next merge. Pick a
 * horizon comfortably beyond your worst-case offline window. Returns new meta
 * (input untouched); present-record clocks are untouched.
 */
export function gcTombstones(meta: SyncMeta, beforeWall: number): SyncMeta {
	const cols: Record<string, ColMeta> = {};
	for (const [name, col] of Object.entries(meta.cols)) {
		const next = cloneCol(col);
		for (const [id, clk] of Object.entries(next.deleted)) {
			if (hlcWall(clk) < beforeWall) delete next.deleted[id];
		}
		cols[name] = next;
	}
	return { node: meta.node, clock: meta.clock, cols };
}

/**
 * Diff `collections` against the metadata's content hashes, assign a fresh clock
 * to every added or changed record, and tombstone records that disappeared.
 * Returns new metadata (input untouched). Call on every local save.
 */
type Tick = () => Hlc;

/** Stamp each present record: a fresh clock for anything added or changed (by
 *  content hash). Returns the set of ids seen, for the tombstone pass. */
function stampPresent(
	col: ColMeta,
	present: unknown[],
	config: SyncConfig,
	name: string,
	tick: Tick
): Set<Id> {
	const fieldLevel = strategyOf(config, name) === 'lww-map';
	const seen = new Set<Id>();
	for (const doc of present) {
		const id = idOf(config, name, doc);
		if (id === null) continue;
		seen.add(id);
		const h = hash(doc);
		if (col.hashes[id] !== h) {
			col.clocks[id] = tick();
			col.hashes[id] = h;
			delete col.deleted[id];
			if (fieldLevel && isRecord(doc)) stampFields(col, id, doc, tick);
		}
	}
	return seen;
}

/** Stamp each added/changed field of one record ('lww-map'): a field keeps its
 *  clock until its own content changes, so field clocks stay independent and a
 *  merge can tell which side last touched which field. */
function stampFields(col: ColMeta, id: Id, doc: Record<string, unknown>, tick: Tick): void {
	const rec = ((col.fields ??= {})[id] ??= {});
	for (const key of Object.keys(doc)) {
		const h = hash(doc[key]);
		if (rec[key]?.[1] !== h) rec[key] = [tick(), h];
	}
	for (const key of Object.keys(rec)) if (!(key in doc)) delete rec[key];
}

/** Tombstone every previously-tracked id that is no longer present. */
function tombstoneMissing(col: ColMeta, seen: Set<Id>, tick: Tick): void {
	for (const id of Object.keys(col.clocks)) {
		if (!seen.has(id)) {
			col.deleted[id] = tick();
			delete col.clocks[id];
			delete col.hashes[id];
			delete col.fields?.[id];
		}
	}
}

export function stamp(
	meta: SyncMeta,
	collections: Record<string, unknown[]>,
	config: SyncConfig,
	wallNow: number = Date.now()
): SyncMeta {
	let clock = meta.clock;
	const tick: Tick = () => (clock = issue(clock, meta.node, wallNow));
	const cols: Record<string, ColMeta> = {};
	const names = new Set([...Object.keys(meta.cols), ...Object.keys(collections)]);

	for (const name of names) {
		const strategy = strategyOf(config, name);
		const col = cloneCol(meta.cols[name]);
		const present = collections[name] ?? [];

		const seen = stampPresent(col, present, config, name, tick);
		if (strategy !== 'grow-set') tombstoneMissing(col, seen, tick);
		cols[name] = col;
	}
	return { node: meta.node, clock, cols };
}

/** One replica's full state: the collections plus their sync metadata. What
 *  `merge` and `detectConflicts` take on each side. */
export interface ReplicaState {
	collections: Record<string, unknown[]>;
	meta: SyncMeta;
}
type State = ReplicaState;

/**
 * Merge replica `b` into `a` (commutative for the convergent strategies). The
 * optional `base` lets 'manual' tell a true concurrent conflict from a one-sided
 * change; without it, 'manual' errs toward surfacing.
 */
export function merge(a: State, b: State, config: SyncConfig, base?: SyncMeta): MergeResult {
	const conflicts: Conflict[] = [];
	const outCols: Record<string, unknown[]> = {};
	const outMeta: SyncMeta = {
		node: a.meta.node,
		clock: max(a.meta.clock, b.meta.clock),
		cols: {}
	};

	const names = new Set([
		...Object.keys(a.collections),
		...Object.keys(b.collections),
		...Object.keys(a.meta.cols),
		...Object.keys(b.meta.cols)
	]);

	for (const name of names) {
		const merged = mergeCollection(name, a, b, config, base, conflicts);
		outCols[name] = merged.docs;
		outMeta.cols[name] = merged.col;
	}

	return { collections: outCols, meta: outMeta, conflicts };
}

/**
 * Concurrent same-id edits that a convergent strategy resolves silently by keeping
 * the later clock. Informational only: it never changes what `merge` keeps, it
 * reports which records both replicas changed since `base` (the loser's version is
 * the one merge dropped). Empty without a base, since two-way state alone cannot
 * tell a concurrent edit from a one-sided change.
 */
export function detectConflicts(
	a: State,
	b: State,
	config: SyncConfig,
	base?: SyncMeta
): Conflict[] {
	if (!base) return [];
	const out: Conflict[] = [];
	const names = new Set([...Object.keys(a.collections), ...Object.keys(b.collections)]);
	for (const name of names) {
		const strategy = strategyOf(config, name);
		const aDocs = byId(config, name, a.collections[name]);
		const bDocs = byId(config, name, b.collections[name]);
		const aMeta = a.meta.cols[name] ?? emptyCol();
		const bMeta = b.meta.cols[name] ?? emptyCol();
		const baseMeta = base.cols[name];
		for (const id of new Set<Id>([...aDocs.keys(), ...bDocs.keys()])) {
			const aClk = aMeta.clocks[id] ?? null;
			const bClk = bMeta.clocks[id] ?? null;
			const winnerSide = pickWinner(aClk, bClk, aDocs.has(id));
			// lww-map merges different-field edits cleanly: only the same field
			// changed on both sides is a real (auto-resolved) conflict.
			const conflict =
				strategy === 'lww-map'
					? fieldConflict(
							name,
							id,
							aDocs,
							bDocs,
							aMeta.fields?.[id],
							bMeta.fields?.[id],
							baseMeta?.fields?.[id],
							winnerSide
						)
					: manualConflict(name, id, aDocs, bDocs, aClk, bClk, baseMeta, winnerSide);
			if (conflict) out.push(conflict);
		}
	}
	return out;
}

/** The 'lww-map' conflict check: a Conflict only when the same field changed on
 *  both sides since base (different-field edits merge without loss). */
function fieldConflict(
	name: string,
	id: Id,
	aDocs: Map<Id, unknown>,
	bDocs: Map<Id, unknown>,
	aF: Record<string, [Hlc, number]> | undefined,
	bF: Record<string, [Hlc, number]> | undefined,
	baseF: Record<string, [Hlc, number]> | undefined,
	winnerSide: 'local' | 'remote'
): Conflict | null {
	if (!(aDocs.has(id) && bDocs.has(id) && aF && bF)) return null;
	for (const key of Object.keys(aF)) {
		const a = aF[key];
		const b = bF[key];
		if (!b || a[0] === b[0]) continue;
		const baseClk = baseF?.[key]?.[0] ?? null;
		const aChanged = !baseClk || compare(a[0], baseClk) > 0;
		const bChanged = !baseClk || compare(b[0], baseClk) > 0;
		if (aChanged && bChanged)
			return {
				collection: name,
				id,
				local: aDocs.get(id),
				remote: bDocs.get(id),
				kept: winnerSide
			};
	}
	return null;
}

/** The 'manual' concurrent-edit check for one record: a Conflict when both sides
 *  changed the same id since `base` (or, without a base, both simply hold it and
 *  their clocks differ). Pure; null when there is nothing to surface. */
function manualConflict(
	name: string,
	id: Id,
	aDocs: Map<Id, unknown>,
	bDocs: Map<Id, unknown>,
	aClk: Hlc | null,
	bClk: Hlc | null,
	baseMeta: ColMeta | undefined,
	winnerSide: 'local' | 'remote'
): Conflict | null {
	if (!(aDocs.has(id) && bDocs.has(id) && aClk && bClk && aClk !== bClk)) return null;
	const baseClk = baseMeta?.clocks[id] ?? null;
	const aChanged = !baseClk || compare(aClk, baseClk) > 0;
	const bChanged = !baseClk || compare(bClk, baseClk) > 0;
	if (!(aChanged && bChanged)) return null;
	return { collection: name, id, local: aDocs.get(id), remote: bDocs.get(id), kept: winnerSide };
}

/** Reconcile every id of one collection across the two replicas. */
function mergeCollection(
	name: string,
	a: State,
	b: State,
	config: SyncConfig,
	base: SyncMeta | undefined,
	conflicts: Conflict[]
): { docs: unknown[]; col: ColMeta } {
	const strategy = strategyOf(config, name);
	const aDocs = byId(config, name, a.collections[name]);
	const bDocs = byId(config, name, b.collections[name]);
	const aMeta = a.meta.cols[name] ?? emptyCol();
	const bMeta = b.meta.cols[name] ?? emptyCol();
	const baseMeta = base?.cols[name];
	const col = emptyCol();
	const docs: unknown[] = [];

	const ids = new Set<Id>([
		...Object.keys(aMeta.clocks),
		...Object.keys(bMeta.clocks),
		...Object.keys(aMeta.deleted),
		...Object.keys(bMeta.deleted),
		...aDocs.keys(),
		...bDocs.keys()
	]);

	for (const id of ids) {
		const aClk = aMeta.clocks[id] ?? null;
		const bClk = bMeta.clocks[id] ?? null;
		const aliveClk = max(aClk, bClk);
		const deadClk = max(aMeta.deleted[id] ?? null, bMeta.deleted[id] ?? null);

		const deleteWins =
			strategy !== 'grow-set' && deadClk && (!aliveClk || compare(deadClk, aliveClk) > 0);

		if (deleteWins) {
			col.deleted[id] = deadClk as Hlc;
			continue;
		}
		if (!aliveClk) {
			if (deadClk) col.deleted[id] = deadClk;
			continue;
		}

		const aHas = aDocs.has(id);
		const winnerSide = pickWinner(aClk, bClk, aHas);
		let doc = winnerSide === 'local' ? aDocs.get(id) : bDocs.get(id);

		if (strategy === 'manual') {
			const conflict = manualConflict(name, id, aDocs, bDocs, aClk, bClk, baseMeta, winnerSide);
			if (conflict) conflicts.push(conflict);
		}

		if (strategy === 'lww-map') {
			const merged = mergeFields(id, aDocs.get(id), bDocs.get(id), aMeta, bMeta, winnerSide);
			if (merged) {
				doc = merged.doc;
				(col.fields ??= {})[id] = merged.fields;
			} else {
				// One side has no document: the record-level winner stands; carry its
				// field metadata forward so later merges stay field-aware.
				const f = (winnerSide === 'local' ? aMeta : bMeta).fields?.[id];
				if (f) (col.fields ??= {})[id] = { ...f };
			}
		}

		if (doc !== undefined) {
			docs.push(doc);
			col.clocks[id] = aliveClk;
			col.hashes[id] = hash(doc);
		}
	}

	return { docs, col };
}

/** Field-by-field merge of one record ('lww-map'): each field goes to the side
 *  whose field clock is later; a field only one side stamped keeps that side's
 *  value; unstamped fields (written under a record-level strategy) follow the
 *  record-level winner.
 *  Null when either document is missing (the record-level result stands). */
function mergeFields(
	id: Id,
	aDoc: unknown,
	bDoc: unknown,
	aMeta: ColMeta,
	bMeta: ColMeta,
	winnerSide: 'local' | 'remote'
): { doc: Record<string, unknown>; fields: Record<string, [Hlc, number]> } | null {
	if (!isRecord(aDoc) || !isRecord(bDoc)) return null;
	const aF = aMeta.fields?.[id] ?? {};
	const bF = bMeta.fields?.[id] ?? {};
	const doc: Record<string, unknown> = {};
	const fields: Record<string, [Hlc, number]> = {};
	for (const key of new Set([...Object.keys(aDoc), ...Object.keys(bDoc)])) {
		const a = aF[key] ?? null;
		const b = bF[key] ?? null;
		const side = pickFieldSide(a, b, winnerSide);
		const src = side === 'local' ? aDoc : bDoc;
		if (!(key in src)) continue; // the winning side removed the field: drop it
		doc[key] = src[key];
		const stamped = side === 'local' ? a : b;
		if (stamped) fields[key] = stamped;
	}
	return { doc, fields };
}

/** Which side supplies one field of an 'lww-map' record: the later field clock
 *  when both sides stamped it, the stamping side when only one did, else the
 *  record-level winner (unstamped fields follow the record). */
function pickFieldSide(
	a: [Hlc, number] | null,
	b: [Hlc, number] | null,
	winnerSide: 'local' | 'remote'
): 'local' | 'remote' {
	if (a && b) return compare(a[0], b[0]) >= 0 ? 'local' : 'remote';
	if (a) return 'local';
	if (b) return 'remote';
	return winnerSide;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Which side's value to keep for a record. With both clocks present, the later
 *  clock wins (ties to local); otherwise the side that actually holds the doc. */
function pickWinner(aClk: Hlc | null, bClk: Hlc | null, aHas: boolean): 'local' | 'remote' {
	if (aClk && bClk) return compare(aClk, bClk) >= 0 ? 'local' : 'remote';
	return aHas ? 'local' : 'remote';
}

function byId(
	config: SyncConfig,
	collection: string,
	docs: unknown[] | undefined
): Map<Id, unknown> {
	const m = new Map<Id, unknown>();
	for (const d of docs ?? []) {
		const id = idOf(config, collection, d);
		if (id !== null) m.set(id, d);
	}
	return m;
}

/** What a merge did to one collection, counted by record. */
export interface CollectionChanges {
	added: number;
	updated: number;
	removed: number;
}

/** Per-collection record counts of what changed between two states (same id
 *  resolution as the merge). Collections with no change are omitted, so an empty
 *  result means the states are equivalent. Feeds the sync journal. */
export function changes(
	before: Record<string, unknown[]>,
	after: Record<string, unknown[]>,
	config: SyncConfig
): Record<string, CollectionChanges> {
	const out: Record<string, CollectionChanges> = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const b = byId(config, name, before[name]);
		const a = byId(config, name, after[name]);
		let added = 0;
		let updated = 0;
		let removed = 0;
		for (const [id, doc] of a) {
			if (!b.has(id)) added++;
			else if (hash(doc) !== hash(b.get(id))) updated++;
		}
		for (const id of b.keys()) if (!a.has(id)) removed++;
		if (added || updated || removed) out[name] = { added, updated, removed };
	}
	return out;
}
