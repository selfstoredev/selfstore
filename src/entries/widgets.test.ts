// @vitest-environment happy-dom
/**
 * Registering one widget must register exactly what that widget needs, and
 * nothing else. Two rules carry this file.
 *
 * A widget that COMPOSES another has to bring it: the composition happens by
 * tag name, so a missing child renders as an inert unknown element instead of
 * failing - a fault nobody sees until a user stares at an empty box.
 *
 * And a widget must NOT bring what it does not compose. That is the whole
 * reason these functions exist: `defineSelfstoreWidgets` names all nine
 * elements, so no bundler can drop one, and an app showing a first-run screen
 * ships the backups manager it never renders. A test that only checked the
 * first rule would pass on a function that registers everything.
 *
 * Each case takes a FRESH module instance. A custom element constructor can be
 * registered under one tag name and no more (that is the spec, not a quirk), so
 * reusing the same classes under a second prefix throws - and the isolation
 * that gives each case its own registry entries also gives it its own classes.
 */

import { describe, it, expect, vi } from 'vitest';

const NOMS = [
	'connect',
	'status',
	'share',
	'join',
	'backups',
	'gate',
	'destination',
	'storage',
	'account'
] as const;

/** Fresh module, one define call, and the tags it actually registered. */
async function tagsDe(prefix: string, nom: string): Promise<string[]> {
	vi.resetModules();
	const m = (await import('./widgets')) as unknown as Record<string, (p: string) => void>;
	m[nom](prefix);
	return NOMS.filter((n) => customElements.get(`${prefix}-${n}`) !== undefined).sort();
}

describe('registering one widget brings exactly its own', () => {
	it('connect, status, share, join and backups stand alone', async () => {
		expect(await tagsDe('t1', 'defineConnect')).toEqual(['connect']);
		expect(await tagsDe('t2', 'defineStatus')).toEqual(['status']);
		expect(await tagsDe('t3', 'defineShare')).toEqual(['share']);
		expect(await tagsDe('t4', 'defineJoin')).toEqual(['join']);
		expect(await tagsDe('t5', 'defineBackups')).toEqual(['backups']);
	});

	it('the gate brings the connect child it builds for itself', async () => {
		// Without connect, the gate renders an unknown element and the journey
		// never appears - visible only to whoever opens the app.
		expect(await tagsDe('t6', 'defineGate')).toEqual(['connect', 'gate']);
	});

	it('the destination panel brings the two elements it composes', async () => {
		expect(await tagsDe('t7', 'defineDestination')).toEqual(['connect', 'destination', 'status']);
	});

	it('storage brings the whole journey it chooses between', async () => {
		expect(await tagsDe('t8', 'defineStorage')).toEqual([
			'connect',
			'destination',
			'gate',
			'status',
			'storage'
		]);
	});

	it('account brings the status row it composes', async () => {
		expect(await tagsDe('t9', 'defineAccount')).toEqual(['account', 'status']);
	});
});

describe('what a single widget must NOT drag in', () => {
	it('a first-run screen does not register the backups manager', async () => {
		// The point of the whole change: this is the widget an app pays for
		// today without ever rendering it.
		const t = await tagsDe('t10', 'defineGate');
		expect(t).not.toContain('backups');
		expect(t).not.toContain('share');
		expect(t).not.toContain('join');
	});

	it('a status line registers one element where the barrel registers nine', async () => {
		expect(await tagsDe('t11', 'defineStatus')).toHaveLength(1);
		expect(await tagsDe('t12', 'defineSelfstoreWidgets')).toHaveLength(9);
	});
});

describe('the barrel still registers everything', () => {
	it('names all nine, so an existing app keeps working unchanged', async () => {
		expect(await tagsDe('t13', 'defineSelfstoreWidgets')).toEqual([
			'account',
			'backups',
			'connect',
			'destination',
			'gate',
			'join',
			'share',
			'status',
			'storage'
		]);
	});

	it('is safe to call twice, and safe after a single-widget call', async () => {
		vi.resetModules();
		const m = await import('./widgets');
		m.defineGate('t14');
		expect(() => m.defineSelfstoreWidgets('t14')).not.toThrow();
		expect(() => m.defineSelfstoreWidgets('t14')).not.toThrow();
		expect(NOMS.filter((n) => customElements.get(`t14-${n}`) !== undefined)).toHaveLength(9);
	});
});
