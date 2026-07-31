/**
 * Hybrid Logical Clock: wall time + a counter + a node id, giving a
 * deterministic total order that tolerates clock skew. Encoded as a fixed-width
 * string so a plain string comparison equals causal order.
 */

export type Hlc = string;

interface Parts {
	wall: number;
	counter: number;
	node: string;
}

const WALL_W = 15;
const CTR_W = 6;

function encode(p: Parts): Hlc {
	return `${String(p.wall).padStart(WALL_W, '0')}|${String(p.counter).padStart(CTR_W, '0')}|${p.node}`;
}

function decode(h: Hlc): Parts {
	const i = h.indexOf('|');
	const j = h.indexOf('|', i + 1);
	return { wall: Number(h.slice(0, i)), counter: Number(h.slice(i + 1, j)), node: h.slice(j + 1) };
}

/**
 * A fresh random replica id (one per device). Not a secret - but two replicas
 * sharing an id lose the tiebreak that makes the order total, so it comes from
 * the same source as everything else here. `randomUUID` is exposed only in a
 * secure context; `getRandomValues` is not, which is why the fallback is that
 * one and never `Math.random`.
 */
export function createNode(): string {
	if (typeof crypto === 'undefined') {
		throw new TypeError(
			'createNode(): this platform provides no WebCrypto, so no replica id can be minted ' +
				'(evergreen browsers, Node 20+).'
		);
	}
	if (crypto.randomUUID) return crypto.randomUUID();
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How far ahead of local wall time a clock minted elsewhere may sit before this
 * replica refuses it.
 *
 * A hybrid logical clock absorbs the highest value it sees, so ONE impossible
 * wall time does three things at once: it wins every last-writer-wins
 * comparison from then on, it raises the clock of every replica that merges it
 * (and of every replica those merge with, in turn), and it keeps doing so after
 * whoever sent it has been removed from the group. Five minutes leaves room for
 * a device whose clock was never synchronised; nothing legitimate needs more.
 */
export const MAX_DRIFT_MS = 5 * 60_000;

/** Whether `h` claims a wall time further ahead than the drift bound allows. */
export function driftedAhead(
	h: Hlc,
	wallNow: number = Date.now(),
	maxDriftMs: number = MAX_DRIFT_MS
): boolean {
	return hlcWall(h) > wallNow + maxDriftMs;
}

/** Issue a clock for a local event. Monotonic per node even if the wall clock moves back. */
export function issue(prev: Hlc | null, node: string, wallNow: number = Date.now()): Hlc {
	const p = prev ? decode(prev) : null;
	const prevWall = p ? p.wall : 0;
	const wall = Math.max(wallNow, prevWall);
	const counter = wall === prevWall && p ? p.counter + 1 : 0;
	return encode({ wall, counter, node });
}

/** Fold a clock observed from another replica into the local one. */
export function receive(
	local: Hlc | null,
	remote: Hlc,
	node: string,
	wallNow: number = Date.now()
): Hlc {
	const l = local ? decode(local) : { wall: 0, counter: 0, node };
	const r = decode(remote);
	const wall = Math.max(wallNow, l.wall, r.wall);
	let counter: number;
	if (wall === l.wall && wall === r.wall) counter = Math.max(l.counter, r.counter) + 1;
	else if (wall === l.wall) counter = l.counter + 1;
	else if (wall === r.wall) counter = r.counter + 1;
	else counter = 0;
	return encode({ wall, counter, node });
}

/** The wall-time component (ms since epoch) encoded in a clock, for age-based
 *  pruning (tombstone GC). Not a precise event time - HLC wall can run ahead of
 *  real time under skew - but a safe lower bound on "how old is this at least". */
export function hlcWall(h: Hlc): number {
	return Number(h.slice(0, h.indexOf('|')));
}

/** Total order: <0 if a precedes b, >0 if a follows b, 0 only if identical. */
export function compare(a: Hlc, b: Hlc): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** The later of two clocks. */
export function max(a: Hlc | null, b: Hlc | null): Hlc {
	if (!a) return b as Hlc;
	if (!b) return a;
	return compare(a, b) >= 0 ? a : b;
}
