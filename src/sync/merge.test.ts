import { describe, it, expect } from 'vitest';
import {
	stamp,
	merge,
	detectConflicts,
	createMeta,
	gcTombstones,
	unsyncableCounts,
	idPathFor,
	type SyncConfig,
	type SyncMeta
} from './merge';

import type { SelfstoreError } from '../selfstore/errors';

type Row = { id: string; v: number };

const cfg: SyncConfig = { fallback: 'lww-set' };

/** Apply a sequence of local states to a replica, stamping each, with an
 *  explicit wall clock so tests are deterministic. */
function replica(node: string, states: Record<string, unknown[]>[], startWall = 1000) {
	let meta = createMeta(node);
	let last: Record<string, unknown[]> = {};
	states.forEach((s, i) => {
		meta = stamp(meta, s, cfg, startWall + i);
		last = s;
	});
	return { collections: last, meta };
}

/** Normalize a merged collection to an id-keyed map, order-independent. */
function asSet(docs: unknown[]): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	for (const d of docs) o[(d as Row).id] = d;
	return o;
}

describe('merge:lww-set', () => {
	it('unions edits made to different records on two devices', () => {
		const A = replica('a', [
			{ rows: [{ id: '1', v: 1 }] },
			{
				rows: [
					{ id: '1', v: 1 },
					{ id: '2', v: 2 }
				]
			}
		]);
		const B = replica(
			'b',
			[
				{ rows: [{ id: '1', v: 1 }] },
				{
					rows: [
						{ id: '1', v: 1 },
						{ id: '3', v: 3 }
					]
				}
			],
			2000
		);
		const m = merge(A, B, cfg);
		expect(asSet(m.collections.rows)).toEqual({
			'1': { id: '1', v: 1 },
			'2': { id: '2', v: 2 },
			'3': { id: '3', v: 3 }
		});
		expect(m.conflicts).toHaveLength(0);
	});

	it('the later edit to the same record wins (skew-proof via HLC)', () => {
		const A = replica('a', [{ rows: [{ id: '1', v: 1 }] }, { rows: [{ id: '1', v: 99 }] }], 5000); // edited later
		const B = replica('b', [{ rows: [{ id: '1', v: 1 }] }, { rows: [{ id: '1', v: 50 }] }], 1000); // earlier wall
		const m = merge(A, B, cfg);
		expect((m.collections.rows[0] as Row).v).toBe(99);
	});

	it('a delete on one device propagates (tombstone)', () => {
		const A = replica(
			'a',
			[
				{
					rows: [
						{ id: '1', v: 1 },
						{ id: '2', v: 2 }
					]
				},
				{ rows: [{ id: '1', v: 1 }] }
			],
			5000
		);
		const B = replica(
			'b',
			[
				{
					rows: [
						{ id: '1', v: 1 },
						{ id: '2', v: 2 }
					]
				}
			],
			1000
		);
		const m = merge(A, B, cfg);
		expect(asSet(m.collections.rows)).toEqual({ '1': { id: '1', v: 1 } });
	});

	it('re-creating a record after a delete beats an older tombstone', () => {
		const A = replica('a', [{ rows: [{ id: '1', v: 1 }] }, { rows: [] }], 1000); // deleted early
		const B = replica('b', [{ rows: [{ id: '1', v: 7 }] }], 5000); // still present, later
		const m = merge(A, B, cfg);
		expect(asSet(m.collections.rows)).toEqual({ '1': { id: '1', v: 7 } });
	});
});

describe('detectConflicts', () => {
	const seed = {
		rows: [
			{ id: '1', v: 1 },
			{ id: '2', v: 2 }
		]
	};
	const base = replica('base', [seed], 1000).meta;
	// A replica that shares the base lineage, then applies its own edit once. An
	// unchanged record keeps its base clock (so it reads as one-sided, not concurrent).
	const from = (node: string, edited: Record<string, unknown[]>, wall: number) => ({
		collections: edited,
		meta: stamp({ node, clock: base.clock, cols: base.cols }, edited, cfg, wall)
	});

	it('flags only the record both replicas changed since the base', () => {
		const A = from(
			'a',
			{
				rows: [
					{ id: '1', v: 10 },
					{ id: '2', v: 2 }
				]
			},
			3000
		); // changed id 1
		const B = from(
			'b',
			{
				rows: [
					{ id: '1', v: 20 },
					{ id: '2', v: 99 }
				]
			},
			5000
		); // changed id 1 and id 2
		const conflicts = detectConflicts(A, B, cfg, base);
		// id 1: concurrent -> conflict; id 2: only B changed -> not a conflict.
		expect(conflicts.map((c) => c.id)).toEqual(['1']);
		expect(conflicts[0].collection).toBe('rows');
		// The kept side is the later clock, i.e. what merge() keeps too.
		expect(conflicts[0].kept).toBe('remote');
		expect((merge(A, B, cfg).collections.rows.find((r) => (r as Row).id === '1') as Row).v).toBe(
			20
		);
	});

	it('returns nothing without a base (cannot tell concurrent from one-sided)', () => {
		const A = from('a', { rows: [{ id: '1', v: 10 }] }, 3000);
		const B = from('b', { rows: [{ id: '1', v: 20 }] }, 5000);
		expect(detectConflicts(A, B, cfg)).toEqual([]);
	});
});

describe('merge:lww-map (field-level)', () => {
	const cfgMap: SyncConfig = { fallback: 'lww-set', strategies: { rows: 'lww-map' } };
	const seed = { rows: [{ id: '1', name: 'Livret', balance: 10 }] };
	const base = stamp(createMeta('base'), seed, cfgMap, 1000);
	/** A replica sharing the base lineage, then applying its own edit once. */
	const fork = (node: string, edited: Record<string, unknown[]>, wall: number) => ({
		collections: edited,
		meta: stamp({ node, clock: base.clock, cols: base.cols }, edited, cfgMap, wall)
	});

	it('concurrent edits to different fields of one record both survive', () => {
		const A = fork('a', { rows: [{ id: '1', name: 'Livret A', balance: 10 }] }, 3000);
		const B = fork('b', { rows: [{ id: '1', name: 'Livret', balance: 99 }] }, 5000);
		const m = merge(A, B, cfgMap);
		expect(m.collections.rows[0]).toEqual({ id: '1', name: 'Livret A', balance: 99 });
	});

	it('the same field resolves to the later edit', () => {
		const A = fork('a', { rows: [{ id: '1', name: 'X', balance: 10 }] }, 3000);
		const B = fork('b', { rows: [{ id: '1', name: 'Y', balance: 10 }] }, 5000);
		expect((merge(A, B, cfgMap).collections.rows[0] as { name: string }).name).toBe('Y');
	});

	it('is commutative and idempotent', () => {
		const A = fork('a', { rows: [{ id: '1', name: 'X', balance: 10 }] }, 3000);
		const B = fork('b', { rows: [{ id: '1', name: 'Livret', balance: 42 }] }, 5000);
		const ab = merge(A, B, cfgMap);
		const ba = merge(B, A, cfgMap);
		expect(asSet(ab.collections.rows)).toEqual(asSet(ba.collections.rows));
		const again = merge({ collections: ab.collections, meta: ab.meta }, B, cfgMap);
		expect(asSet(again.collections.rows)).toEqual(asSet(ab.collections.rows));
	});

	it('a later delete still beats field edits (record-level tombstone)', () => {
		const A = fork('a', { rows: [] }, 5000); // deleted, later
		const B = fork('b', { rows: [{ id: '1', name: 'X', balance: 10 }] }, 3000);
		expect(merge(A, B, cfgMap).collections.rows).toEqual([]);
	});

	it('detectConflicts flags only same-field concurrent edits', () => {
		const differentFields = detectConflicts(
			fork('a', { rows: [{ id: '1', name: 'A', balance: 10 }] }, 3000),
			fork('b', { rows: [{ id: '1', name: 'Livret', balance: 99 }] }, 5000),
			cfgMap,
			base
		);
		expect(differentFields).toEqual([]); // merged cleanly, nothing lost
		const sameField = detectConflicts(
			fork('a', { rows: [{ id: '1', name: 'A', balance: 10 }] }, 3000),
			fork('b', { rows: [{ id: '1', name: 'B', balance: 10 }] }, 5000),
			cfgMap,
			base
		);
		expect(sameField.map((c) => c.id)).toEqual(['1']);
	});
});

describe('merge:convergence laws (CvRDT)', () => {
	const A = replica(
		'a',
		[
			{ rows: [{ id: '1', v: 1 }] },
			{
				rows: [
					{ id: '1', v: 10 },
					{ id: '2', v: 2 }
				]
			}
		],
		3000
	);
	const B = replica(
		'b',
		[
			{ rows: [{ id: '1', v: 1 }] },
			{
				rows: [
					{ id: '1', v: 20 },
					{ id: '3', v: 3 }
				]
			}
		],
		1000
	);
	const C = replica('c', [{ rows: [{ id: '4', v: 4 }] }], 2000);

	it('is commutative (order of peers does not matter)', () => {
		const ab = merge(A, B, cfg);
		const ba = merge(B, A, cfg);
		expect(asSet(ab.collections.rows)).toEqual(asSet(ba.collections.rows));
	});

	it('is idempotent (merging the same state twice is a no-op)', () => {
		const once = merge(A, B, cfg);
		const twice = merge({ collections: once.collections, meta: once.meta }, B, cfg);
		expect(asSet(twice.collections.rows)).toEqual(asSet(once.collections.rows));
	});

	it('is associative (peers can sync in any grouping)', () => {
		const ab_c = merge(merge(A, B, cfg), C, cfg);
		const a_bc = merge(A, merge(B, C, cfg), cfg);
		expect(asSet(ab_c.collections.rows)).toEqual(asSet(a_bc.collections.rows));
	});
});

describe('merge:nested id paths', () => {
	const nested: SyncConfig = { ids: { documents: 'doc.id' }, fallback: 'lww-set' };
	it('keys records by a dot-path id (e.g. documents keyed at doc.id)', () => {
		let mA = createMeta('a');
		mA = stamp(mA, { documents: [{ doc: { id: 'd1' }, pages: 1 }] }, nested, 1000);
		let mB = createMeta('b');
		mB = stamp(mB, { documents: [{ doc: { id: 'd2' }, pages: 2 }] }, nested, 2000);
		const m = merge(
			{ collections: { documents: [{ doc: { id: 'd1' }, pages: 1 }] }, meta: mA },
			{ collections: { documents: [{ doc: { id: 'd2' }, pages: 2 }] }, meta: mB },
			nested
		);
		const ids = (m.collections.documents as { doc: { id: string } }[]).map((d) => d.doc.id).sort();
		expect(ids).toEqual(['d1', 'd2']);
	});
});

describe('merge:grow-set', () => {
	const grow: SyncConfig = { fallback: 'grow-set' };
	it('unions append-only logs and never deletes', () => {
		const A = replica('a', [{ log: [{ id: 'e1', v: 1 }] }], 1000);
		// device B independently appends, and a removal must be ignored (immutable)
		let mB = createMeta('b');
		mB = stamp(mB, { log: [{ id: 'e2', v: 2 }] }, grow, 2000);
		mB = stamp(mB, { log: [] }, grow, 3000); // "removal" ignored for grow-set
		const B = { collections: { log: [{ id: 'e2', v: 2 }] }, meta: mB };
		const m = merge(A, B, grow);
		expect(asSet(m.collections.log)).toEqual({ e1: { id: 'e1', v: 1 }, e2: { id: 'e2', v: 2 } });
	});
});

describe('merge:lww-register', () => {
	const reg: SyncConfig = { strategies: { settings: 'lww-register' } };
	it('keeps the most recently written singleton', () => {
		const A = replica(
			'a',
			[{ settings: [{ id: '_', v: 1 }] }, { settings: [{ id: '_', v: 2 }] }],
			5000
		);
		const B = replica('b', [{ settings: [{ id: '_', v: 9 }] }], 1000);
		const m = merge(A, B, reg);
		expect((m.collections.settings[0] as Row).v).toBe(2);
	});
});

describe('merge:manual', () => {
	const man: SyncConfig = { strategies: { docs: 'manual' } };
	it('surfaces a genuine concurrent edit instead of silently dropping one', () => {
		const base = replica('a', [{ docs: [{ id: '1', v: 0 }] }], 1000);
		// both diverge from the same base, each edits record 1
		const A: { collections: Record<string, unknown[]>; meta: SyncMeta } = {
			collections: { docs: [{ id: '1', v: 11 }] },
			meta: stamp(base.meta, { docs: [{ id: '1', v: 11 }] }, man, 4000)
		};
		const B = {
			collections: { docs: [{ id: '1', v: 22 }] },
			meta: stamp(base.meta, { docs: [{ id: '1', v: 22 }] }, man, 2000)
		};
		const m = merge(A, B, man, base.meta);
		expect(m.conflicts).toHaveLength(1);
		expect(m.conflicts[0]).toMatchObject({ collection: 'docs', id: '1', kept: 'local' });
		// still converges to a single deterministic value (the later write)
		expect((m.collections.docs[0] as Row).v).toBe(11);
	});

	it('does not flag a one-sided change as a conflict', () => {
		const base = replica('a', [{ docs: [{ id: '1', v: 0 }] }], 1000);
		const A = {
			collections: { docs: [{ id: '1', v: 5 }] },
			meta: stamp(base.meta, { docs: [{ id: '1', v: 5 }] }, man, 4000)
		};
		const B = base; // unchanged
		const m = merge(A, B, man, base.meta);
		expect(m.conflicts).toHaveLength(0);
		expect((m.collections.docs[0] as Row).v).toBe(5);
	});
});

describe('unsyncableCounts (non-string id detection)', () => {
	it('counts records with no string id at the configured path, per collection', () => {
		const counts = unsyncableCounts({
			todos: [{ id: '1' }, { id: 2 }, { id: 3 }, { text: 'no id' }], // 3 bad
			notes: [{ id: 'n1' }, { id: 'n2' }], // all good
			empty: []
		});
		expect(counts).toEqual({ todos: 3 });
	});

	it('respects a per-collection id mapping', () => {
		const cfg: SyncConfig = { ids: { events: 'ref' } };
		const counts = unsyncableCounts({ events: [{ ref: 'e1' }, { id: 'x', ref: 5 }] }, cfg);
		expect(counts).toEqual({ events: 1 }); // the second row's ref is a number
		expect(idPathFor(cfg, 'events')).toBe('ref');
	});
});

describe('gcTombstones (bounded metadata)', () => {
	const cfg2: SyncConfig = { fallback: 'lww-set' };

	// A record present at wall 1000, then deleted at wall 2000 (tombstone wall 2000).
	const withTombstone = (): SyncMeta => {
		const m0 = stamp(createMeta('a'), { rows: [{ id: '1' }, { id: '2' }] }, cfg2, 1000);
		return stamp(m0, { rows: [{ id: '2' }] }, cfg2, 2000); // id 1 deleted
	};

	it('prunes tombstones older than the cutoff, keeps present-record clocks', () => {
		const gced = gcTombstones(withTombstone(), 3000); // cutoff after the delete
		expect(gced.cols.rows.deleted).toEqual({}); // the id-1 tombstone is gone
		expect(Object.keys(gced.cols.rows.clocks)).toEqual(['2']); // the live record survives
	});

	it('keeps tombstones newer than the cutoff', () => {
		const gced = gcTombstones(withTombstone(), 1500); // cutoff before the delete
		expect(Object.keys(gced.cols.rows.deleted)).toEqual(['1']); // tombstone retained
	});

	it('does not mutate the input meta', () => {
		const m = withTombstone();
		gcTombstones(m, 3000);
		expect(Object.keys(m.cols.rows.deleted)).toEqual(['1']); // original untouched
	});

	it('a GC that outruns an offline replica resurrects the record (documented tradeoff)', () => {
		// A deleted id 1, tombstone GC'd. A replica that still holds id 1 (never saw
		// the delete) re-introduces it on merge - the reason the horizon must exceed
		// the worst-case offline window.
		const local = gcTombstones(withTombstone(), 3000); // no tombstone for id 1
		const stale = stamp(createMeta('b'), { rows: [{ id: '1' }, { id: '2' }] }, cfg2, 500);
		const m = merge(
			{ collections: { rows: [{ id: '2' }] }, meta: local },
			{ collections: { rows: [{ id: '1' }, { id: '2' }] }, meta: stale },
			cfg2
		);
		expect(asSet(m.collections.rows)).toHaveProperty('1'); // resurrected
	});
});

/**
 * A hybrid logical clock absorbs the highest value it sees. One replica
 * carrying an impossible wall time would win every last-writer-wins
 * comparison from then on, raise the clock of every replica that merges it,
 * and keep doing so long after its author was removed from the group.
 */
describe('clock drift', () => {
	const aheadWall = (): number => Date.now() + 6 * 60_000;

	it('refuses an incoming replica whose clock cannot be real', () => {
		const local = replica('a', [{ rows: [{ id: '1', v: 1 }] }]);
		const ahead = replica('b', [{ rows: [{ id: '1', v: 2 }] }], aheadWall());
		let code = '';
		try {
			merge(local, ahead, cfg);
		} catch (e) {
			code = (e as SelfstoreError).code;
		}
		expect(code).toBe('CLOCK_DRIFT');
	});

	it('refuses a clock that is not in the canonical shape', () => {
		const local = replica('a', [{ rows: [{ id: '1', v: 1 }] }]);
		const forged = replica('b', [{ rows: [{ id: '1', v: 2 }] }]);
		forged.meta.cols.rows.clocks['1'] = 'zzzz|000000|x';
		expect(() => merge(local, forged, cfg)).toThrow(/never writes/);
	});

	it('checks the tombstones and the field clocks too, not just the meta', () => {
		const local = replica('a', [{ rows: [{ id: '1', v: 1 }] }]);
		const ahead = replica('b', [{ rows: [{ id: '1', v: 2 }] }], aheadWall());
		// Keep only a tombstone from the drifted side: the guard must still catch it.
		const meta: SyncMeta = {
			node: ahead.meta.node,
			clock: null,
			cols: { rows: { ...ahead.meta.cols.rows, clocks: {}, hashes: {} } }
		};
		meta.cols.rows.deleted = { '9': ahead.meta.cols.rows.clocks['1'] };
		expect(() => merge(local, { collections: { rows: [] }, meta }, cfg)).toThrow();
	});

	it('still merges when only the local side already absorbed a bad clock', () => {
		// The guard must not strand the very replicas it exists to protect.
		const poisoned = replica('a', [{ rows: [{ id: '1', v: 1 }] }], aheadWall());
		const sane = replica('b', [{ rows: [{ id: '2', v: 2 }] }]);
		expect(() => merge(poisoned, sane, cfg)).not.toThrow();
	});
});

describe('ids and field names that name a prototype', () => {
	const cfgMap: SyncConfig = { fallback: 'lww-set', strategies: { rows: 'lww-map' } };

	it('stamps and merges a record whose id is __proto__ without touching Object.prototype', () => {
		const rows = [{ id: '__proto__', name: 'Livret' }];
		const meta = stamp(createMeta('a'), { rows }, cfgMap, 1000);
		expect(({} as Record<string, unknown>).name).toBeUndefined();
		expect(Object.keys(meta.cols.rows.clocks)).toEqual(['__proto__']);
		// A replica read back from disk holds plain objects again.
		const remote = { collections: { rows }, meta: JSON.parse(JSON.stringify(meta)) as SyncMeta };
		const m = merge({ collections: {}, meta: createMeta('b') }, remote, cfgMap);
		expect(m.collections.rows).toEqual(rows);
		expect(Object.keys(m.meta.cols.rows.clocks)).toEqual(['__proto__']);
		expect(({} as Record<string, unknown>).name).toBeUndefined();
	});

	it('keeps a field named __proto__ as a field of the merged record', () => {
		const doc = JSON.parse('{"id":"1","__proto__":"x","n":1}') as Record<string, unknown>;
		const meta = stamp(createMeta('a'), { rows: [doc] }, cfgMap, 1000);
		const edited = JSON.parse('{"id":"1","__proto__":"x","n":2}') as Record<string, unknown>;
		const B = {
			collections: { rows: [edited] },
			meta: stamp(meta, { rows: [edited] }, cfgMap, 2000)
		};
		const m = merge({ collections: { rows: [doc] }, meta }, B, cfgMap);
		const out = m.collections.rows[0] as Record<string, unknown>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.hasOwn(out, '__proto__')).toBe(true);
		expect(out.n).toBe(2);
	});
});

describe('change detection', () => {
	const before = { id: 'x', value: '12k17wj' };
	const after = { id: 'x', value: '102ue3k' };

	it('stamps a write whose content shared the 32-bit hash of the previous one', () => {
		const first = stamp(createMeta('n'), { rows: [before] }, cfg, 1000);
		const second = stamp(first, { rows: [after] }, cfg, 2000);
		expect(second.cols.rows.clocks.x).not.toEqual(first.cols.rows.clocks.x);
	});

	it('stamps a field whose content shared the 32-bit hash of the previous one', () => {
		const map: SyncConfig = { fallback: 'lww-map' };
		const first = stamp(createMeta('n'), { rows: [{ id: 'x', a: before }] }, map, 1000);
		const second = stamp(first, { rows: [{ id: 'x', a: after }] }, map, 2000);
		expect(second.cols.rows.fields?.x.a[0]).not.toEqual(first.cols.rows.fields?.x.a[0]);
	});

	it('keeps the clock of a record an older replica stamped with its 32-bit hash', () => {
		const map: SyncConfig = { fallback: 'lww-map' };
		const doc = { id: 'x', a: 1 };
		const current = stamp(createMeta('n'), { rows: [doc] }, map, 1000);
		const rows = current.cols.rows;
		// The 32-bit FNV-1a of the stable form, as replicas stored it before.
		const legacy = (s: string): number => {
			let h = 0x811c9dc5;
			for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
			return h >>> 0;
		};
		const older: SyncMeta = {
			...current,
			cols: {
				rows: {
					...rows,
					hashes: { x: legacy('{"a":1,"id":"x"}') },
					fields: {
						x: { a: [rows.fields!.x.a[0], legacy('1')], id: [rows.fields!.x.id[0], legacy('"x"')] }
					}
				}
			}
		};
		const again = stamp(older, { rows: [doc] }, map, 5000);
		expect(again.cols.rows.clocks.x).toEqual(rows.clocks.x);
		expect(again.cols.rows.hashes.x).toBe(rows.hashes.x);
		expect(again.cols.rows.fields?.x).toEqual(rows.fields?.x);
		expect(again.clock).toEqual(current.clock);
	});
});

describe('merge after a migration', () => {
	it('keeps a remote record its metadata no longer tracks on a blank device', () => {
		// The backup was stamped under `accounts`; the migration renamed it `wallets`.
		const remote = replica('r', [{ accounts: [{ id: 'a1', v: 1 }] }]);
		const migrated = { collections: { wallets: [{ id: 'a1', v: 1 }] }, meta: remote.meta };
		const blank = { collections: {}, meta: stamp(createMeta('l'), {}, cfg, 2000) };
		const out = merge(blank, migrated, cfg);
		expect(out.collections.wallets).toEqual([{ id: 'a1', v: 1 }]);
		// Stamped on the next local save, like any new record.
		const next = stamp(out.meta, out.collections, cfg, 3000);
		expect(next.cols.wallets.clocks.a1).toBeDefined();
	});

	it('still lets a tombstone remove an untracked record', () => {
		const local = replica('l', [{ rows: [{ id: 'a1', v: 1 }] }, { rows: [] }]);
		const untracked = { collections: { rows: [{ id: 'a1', v: 1 }] }, meta: createMeta('r') };
		expect(merge(local, untracked, cfg).collections.rows).toEqual([]);
	});
});
