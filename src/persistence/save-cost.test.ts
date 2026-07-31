/**
 * What one edit costs to save, as the data grows.
 *
 * A save rebuilds and re-uploads EVERYTHING: the cost follows the size of the
 * whole store, not the size of the change. That is a deliberate trade (this is
 * a backup-shaped store, not a delta sync engine), and it is fine at the sizes
 * real vaults have. But nothing watched the number, so the day a change to the
 * merge layer doubles it, the first to notice would be a user six years in.
 *
 * Budgets are in BYTES, never milliseconds. Wall clock on a shared CI runner
 * says more about the neighbours than about this code, and a flaky red is worse
 * than no test at all. Bytes are deterministic, they are what the user's
 * connection actually pays, and they move only when the format or the
 * bookkeeping moves.
 *
 * A budget that trips is not automatically a bug: it is a change in what every
 * save costs, and it deserves a sentence in the changelog either way. Raise it
 * on purpose, with the reason, or find what grew.
 */

import { describe, it, expect } from 'vitest';
import { selfstore } from '../simple/simple';
import { memoryCache } from './cache';
import type { BackupTarget } from './target';

/** Fixed fixture: the numbers below only mean something if the record shape
 *  never drifts. A session-like record, the shape a real vault accumulates. */
function seance(i: number): Record<string, unknown> {
	return {
		id: `s${i}`,
		analysant: `a${i % 25}`,
		date: '2026-05-15',
		duree: 45,
		montant: 60,
		regle: i % 3 !== 0,
		note: 'Seance ordinaire, rien de particulier a signaler.'
	};
}

function cible(): { target: BackupTarget; octets: () => number } {
	let taille = 0;
	return {
		target: {
			kind: 'bench',
			label: 'bench',
			async save(b) {
				taille = b.size;
				return null;
			},
			async load() {
				return null;
			},
			async isReady() {
				return true;
			},
			async reconnect() {
				return true;
			},
			async disconnect() {}
		},
		octets: () => taille
	};
}

/** Fill a protected store, then measure what ONE further edit pushes. */
async function coutDUneModification(n: number): Promise<{ ko: number; ms: number }> {
	const store = await selfstore('save-cost', { cache: memoryCache() });
	try {
		const c = cible();
		await store.connectTarget(c.target);
		await store.protect('un-mot-de-passe-assez-long');
		for (let i = 0; i < n; i++) await store.put('seances', seance(i));
		await store.flush();

		await store.put('seances', { ...seance(0), duree: 50 });
		const t0 = performance.now();
		await store.flush();
		return { ko: c.octets() / 1024, ms: performance.now() - t0 };
	} finally {
		store.dispose();
	}
}

describe('what one edit costs to save', () => {
	// Measured 2026-08-01: 19 kB at 1k, 163 kB at 10k. The budgets sit ~25% above
	// so a normal format tweak does not trip them, and a doubling always does.
	it.each([
		[1_000, 25],
		[10_000, 205]
	])('%i records: one edit pushes under %i kB', async (n, budget) => {
		const { ko, ms } = await coutDUneModification(n);
		// Reported, never asserted: it says how the cost feels, and it is the
		// number a shared runner cannot be trusted on.
		console.log(`    ${n} enregistrements -> ${ko.toFixed(0)} kB, ${ms.toFixed(0)} ms`);
		expect(ko).toBeLessThan(budget);
	});

	it('grows with the whole store, not with the change', async () => {
		// The property behind the budgets, asserted so the trade stays explicit:
		// ten times the data costs several times the save, for the same one-record
		// edit. If this ever stops holding, someone built delta sync and the
		// budgets above are the wrong shape entirely.
		const petit = await coutDUneModification(1_000);
		const grand = await coutDUneModification(10_000);
		expect(grand.ko).toBeGreaterThan(petit.ko * 3);
	});
});
