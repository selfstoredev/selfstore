// @vitest-environment happy-dom
/**
 * <selfstore-gate>: prove it opens on the library's own signal and nothing
 * else, that it never rebuilds its frame under a journey in progress, and that
 * the way out is honest (deferring shuts it for the session, and says so).
 */

import { describe, it, expect } from 'vitest';
import type { FlowHost } from '../flows/connect';
import type { LocalStore } from '../persistence/store';
import {
	defineSelfstoreWidgets,
	SelfstoreConnectElement,
	SelfstoreGateElement
} from '../entries/widgets';

defineSelfstoreWidgets();

const CHOOSE = {
	state: 'cache-only',
	severity: 'warn',
	actionable: true,
	action: 'choose-destination',
	labelKey: 'status.cacheOnly'
};

/** A hand-rolled engine stub: state + subscribe, nothing else consulted. */
function fakeEngine(status: Record<string, unknown> = CHOOSE) {
	const subs = new Set<() => void>();
	const state = {
		targetKind: 'device',
		label: null as string | null,
		lastSavedAt: null as number | null,
		status
	};
	const engine = {
		state,
		subscribe(fn: () => void) {
			subs.add(fn);
			return () => subs.delete(fn);
		}
	} as unknown as LocalStore;
	return {
		engine,
		set(next: Partial<typeof state>) {
			Object.assign(state, next);
			for (const fn of subs) fn();
		}
	};
}

function mount(engine: LocalStore): SelfstoreGateElement {
	const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
	document.body.append(el);
	el.targets = { file: true };
	el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
	return el;
}

const q = (el: HTMLElement, sel: string): HTMLElement | null =>
	el.shadowRoot!.querySelector<HTMLElement>(sel);

describe('selfstore-gate', () => {
	it('stays inert until it has a store', () => {
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		document.body.append(el);
		expect(el.open).toBe(false);
		expect(q(el, '[part~="gate"]')).toBeNull();
		el.remove();
	});

	it('opens on choose-destination and closes when the store gets a home', () => {
		const { engine, set } = fakeEngine();
		const el = mount(engine);

		expect(el.open).toBe(true);
		expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Where should your data live?');
		expect(q(el, 'selfstore-connect')).not.toBeNull();

		set({
			targetKind: 'file',
			status: { state: 'saved', severity: 'ok', actionable: false, labelKey: 'status.saved' }
		});
		expect(el.open).toBe(false);
		expect(q(el, '[part~="gate"]')).toBeNull();
		expect(el.connect).toBeNull();
		el.remove();
	});

	it('does not open over another actionable status', () => {
		// A destination needing attention outranks a missing one: demanding a new
		// choice here would hide the real problem behind a first-run screen.
		const { engine } = fakeEngine({
			state: 'needs-attention',
			severity: 'danger',
			actionable: true,
			action: 'reconnect',
			labelKey: 'status.needsAttention'
		});
		const el = mount(engine);
		expect(el.open).toBe(false);
		el.remove();
	});

	it('holds shut while the app says it is still booting', () => {
		const { engine } = fakeEngine();
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		el.setAttribute('armed', 'false');
		document.body.append(el);
		el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
		expect(el.open).toBe(false);

		el.armed = true;
		expect(el.open).toBe(true);
		el.remove();
	});

	it('deferring shuts it for the session, and can be undone', () => {
		const { engine, set } = fakeEngine();
		const el = mount(engine);
		let deferred = 0;
		el.addEventListener('selfstore-gate-deferred', () => deferred++);

		const note = q(el, '[part~="gate-defer-note"]')!;
		expect(note.textContent).toContain('lost if its storage is cleared');
		q(el, 'button[part~="gate-defer"]')!.click();

		expect(deferred).toBe(1);
		expect(el.open).toBe(false);
		set({ status: { ...CHOOSE } }); // still homeless: it must not come back
		expect(el.open).toBe(false);

		el.deferred = false;
		expect(el.open).toBe(true);
		el.remove();
	});

	it('deferrable=false leaves no way out', () => {
		const { engine } = fakeEngine();
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		el.setAttribute('deferrable', 'false');
		document.body.append(el);
		el.targets = { file: true };
		el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };

		expect(el.open).toBe(true);
		expect(q(el, 'button[part~="gate-defer"]')).toBeNull();
		el.remove();
	});

	it('forwards its configuration to the connect child and drops its heading', () => {
		const { engine } = fakeEngine();
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		document.body.append(el);
		el.labels = { 'gate.title': 'Ou garder vos donnees ?' };
		el.targets = { file: true, webdav: true };
		el.recommended = 'file';
		el.advanced = ['webdav'];
		el.icons = { file: 'file.svg' };
		el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };

		expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Ou garder vos donnees ?');
		const child = el.connect!;
		expect(child.recommended).toBe('file');
		expect(child.advanced).toEqual(['webdav']);
		expect(child.icons).toEqual({ file: 'file.svg' });
		// The gate's own title asks the question; the child's would repeat it.
		expect(child.labels['connect.title']).toBe('');
		expect(child.shadowRoot!.textContent).not.toContain('Where should we save your data?');
		el.remove();
	});

	it('keeps the same connect element across notifications, so a journey survives', () => {
		const { engine, set } = fakeEngine();
		const el = mount(engine);
		const first = el.connect;
		expect(first).not.toBeNull();

		// A status tick that leaves the gate open (a save attempt, a label change)
		// must not rebuild the frame: re-appending the child would rebuild its
		// flow and drop whatever the user was in the middle of.
		set({ label: 'somewhere' });
		set({ status: { ...CHOOSE } });
		expect(el.connect).toBe(first);

		// Late cosmetics reach the child without a rebuild either.
		el.icons = { file: 'other.svg' };
		expect(el.connect).toBe(first);
		expect(first!.icons).toEqual({ file: 'other.svg' });
		el.remove();
	});

	it('takes the store late, and re-assigning the same one changes nothing', () => {
		// A host that creates its store AFTER mounting the widget (a vault opened
		// on a later screen) must be able to just assign it from a reactive effect.
		// Re-running that effect re-assigns the same handle, which has to be inert:
		// otherwise hosts need a "wire once" guard, and the obvious guard - keyed on
		// the element - swallows the real assignment and the gate never opens.
		const { engine } = fakeEngine();
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		document.body.append(el);
		el.targets = { file: true };
		expect(el.open).toBe(false);

		const host = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
		el.store = host;
		expect(el.open).toBe(true);
		const child = el.connect;

		el.store = host;
		expect(el.connect).toBe(child);
		el.remove();
	});

	it('builds its connect child under the prefix it was registered with', () => {
		// A custom prefix, as the registry allows it: one constructor per name, so
		// a second registration is a subclass.
		customElements.define('app-connect', class extends SelfstoreConnectElement {});
		customElements.define('app-gate', class extends SelfstoreGateElement {});
		const { engine } = fakeEngine();
		const el = document.createElement('app-gate') as SelfstoreGateElement;
		document.body.append(el);
		el.targets = { file: true };
		el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };

		expect(el.connect!.tagName.toLowerCase()).toBe('app-connect');
		el.remove();

		// Registered under a name that says nothing about a prefix: fall back to
		// the shipped one rather than reaching for a tag nobody defined.
		customElements.define('gatelike-thing', class extends SelfstoreGateElement {});
		const odd = document.createElement('gatelike-thing') as SelfstoreGateElement;
		document.body.append(odd);
		odd.targets = { file: true };
		odd.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
		expect(odd.connect!.tagName.toLowerCase()).toBe('selfstore-connect');
		odd.remove();
	});

	it('names itself for screen readers and offers the host slots', () => {
		const { engine } = fakeEngine();
		const el = mount(engine);
		const dialog = q(el, '[part~="gate"]')!;
		expect(dialog.getAttribute('role')).toBe('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(dialog.getAttribute('aria-labelledby')).toBe('gate-title');
		expect(q(el, '[part~="gate-title"]')!.id).toBe('gate-title');
		const slots = [...el.shadowRoot!.querySelectorAll('slot')].map((s) => s.getAttribute('name'));
		expect(slots).toEqual(['brand', 'extra', 'footer']);
		el.remove();
	});

	// The point of the shipped packs: a French page writes no labels at all.
	describe('shipped translations', () => {
		it('speaks the page language with nothing passed', () => {
			document.documentElement.lang = 'fr';
			const { engine } = fakeEngine();
			const el = mount(engine);
			expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Où enregistrer vos données ?');
			el.remove();
			document.documentElement.lang = '';
		});

		it('takes the closest lang, so one subtree can differ from the page', () => {
			document.documentElement.lang = 'en';
			const box = document.createElement('div');
			box.setAttribute('lang', 'fr-CA');
			document.body.append(box);
			const { engine } = fakeEngine();
			const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
			box.append(el);
			el.targets = { file: true };
			el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
			expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Où enregistrer vos données ?');
			box.remove();
			document.documentElement.lang = '';
		});

		it('lets an override beat the pack, key by key', () => {
			document.documentElement.lang = 'fr';
			const { engine } = fakeEngine();
			// Labels are set before the store opens the gate: the frame is built
			// once, so a host words its screen at setup, not mid-journey.
			const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
			document.body.append(el);
			el.labels = { 'gate.title': 'Votre coffre' };
			el.targets = { file: true };
			el.store = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
			expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Votre coffre');
			expect(q(el, '[part~="gate-hint"]')!.textContent).toContain('chiffrées sur cet appareil');
			el.remove();
			document.documentElement.lang = '';
		});

		it('falls back to English for a language it does not ship', () => {
			document.documentElement.lang = 'de';
			const { engine } = fakeEngine();
			const el = mount(engine);
			expect(q(el, '[part~="gate-title"]')!.textContent).toBe('Where should your data live?');
			el.remove();
			document.documentElement.lang = '';
		});
	});
});
