// @vitest-environment happy-dom
/**
 * <selfstore-status>: a skin over the engine's own StatusDescriptor. Prove it
 * renders the derived status (never invents one), follows the store's
 * notifications, delegates the action through an event, and shrinks to the
 * dot variant.
 */

import { describe, it, expect } from 'vitest';
import type { FlowHost } from '../flows/connect';
import type { LocalStore } from '../persistence/store';
import { defineSelfstoreWidgets, SelfstoreStatusElement } from '../entries/widgets';

defineSelfstoreWidgets();

/** A hand-rolled engine stub: state + subscribe, nothing else consulted. */
function fakeEngine(overrides: Partial<LocalStore['state']> = {}) {
	const subs = new Set<() => void>();
	const state = {
		targetKind: 'drive',
		label: null as string | null,
		lastSavedAt: null as number | null,
		status: {
			state: 'saved',
			severity: 'ok',
			actionable: false,
			labelKey: 'status.saved'
		},
		...overrides
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

function mount(engine: LocalStore): SelfstoreStatusElement {
	const el = document.createElement('selfstore-status') as SelfstoreStatusElement;
	document.body.append(el);
	const host: FlowHost = { engine, kv: {} as FlowHost['kv'], backupName: 'x.zip' };
	el.store = host;
	return el;
}

const q = (el: HTMLElement, sel: string): HTMLElement | null =>
	el.shadowRoot!.querySelector<HTMLElement>(sel);

describe('selfstore-status', () => {
	it('renders the derived status with its severity dot and follows notifications', () => {
		const { engine, set } = fakeEngine();
		const el = mount(engine);

		expect(q(el, '[part="title"]')!.textContent).toBe('Saved');
		expect(q(el, 'span[part~="sev-ok"]')).not.toBeNull();
		expect(q(el, '[part~="status-action"]')).toBeNull(); // not actionable

		set({
			status: {
				state: 'needs-attention',
				severity: 'danger',
				actionable: true,
				action: 'reconnect',
				labelKey: 'status.needsAttention'
			}
		});
		expect(q(el, '[part="title"]')!.textContent).toBe('Reconnect to continue');
		expect(q(el, 'span[part~="sev-danger"]')).not.toBeNull();
		el.remove();
	});

	it('the action button delegates through selfstore-status-action', () => {
		const { engine } = fakeEngine({
			status: {
				state: 'needs-attention',
				severity: 'danger',
				actionable: true,
				action: 'reconnect',
				labelKey: 'status.needsAttention'
			}
		});
		const el = mount(engine);
		let got: string | null = null;
		el.addEventListener('selfstore-status-action', (e) => {
			got = (e as CustomEvent).detail.action;
		});
		const btn = q(el, 'button[part~="status-action"]');
		expect(btn!.textContent).toBe('Reconnect');
		btn!.click();
		expect(got).toBe('reconnect');
		el.remove();
	});

	it('the where line prefers the host label, then the target label, then nothing', () => {
		const { engine } = fakeEngine({ label: 'backup.zip', targetKind: 'file' });
		const el = mount(engine);
		expect(q(el, '[part="sub"]')!.textContent).toBe('backup.zip');
		el.labels = { 'status.where.file': 'A file on this device' };
		expect(q(el, '[part="sub"]')!.textContent).toBe('A file on this device');
		el.remove();
	});

	it('variant=dot renders the labelled dot button alone', () => {
		const { engine } = fakeEngine();
		const el = mount(engine);
		el.variant = 'dot';
		expect(q(el, '[part="title"]')).toBeNull();
		const btn = q(el, 'button[part~="dot-button"]');
		expect(btn).not.toBeNull();
		expect(btn!.getAttribute('aria-label')).toBe('Saved');
		expect(q(el, 'span[part~="status-dot"]')).not.toBeNull();
		el.remove();
	});

	it('names the destination in the sentence when no line below does', () => {
		// A status that cannot say WHERE has to be read twice: the state on one
		// line, the place on another. The pack writes one sentence instead - and
		// the sentence gives the place up the moment the line below carries it,
		// rather than naming the same backup twice in three lines.
		const { engine, set } = fakeEngine({ label: 'cabinet.zip', targetKind: 'file' });
		const el = mount(engine);
		expect(q(el, '[part="sub"]')!.textContent).toContain('cabinet.zip');
		expect(q(el, '[part="title"]')!.textContent).toBe('Saved');

		el.variant = 'dot';
		expect(q(el, 'button')!.getAttribute('aria-label')).toBe(
			'Saved to cabinet.zip, at every change'
		);
		el.variant = 'row';

		// A hole in a sentence reads as a bug nobody can name; the key names it.
		el.labels = { 'status.saved': 'Saved to {label} by {who}', 'status.where.file': '' };
		expect(q(el, '[part="title"]')!.textContent).toBe('Saved to cabinet.zip by {who}');

		// Attached, but with no name to give: the placeholder must never reach the
		// screen, so the placeless twin answers instead.
		el.labels = {};
		set({ label: null });
		expect(q(el, '[part="title"]')!.textContent).toBe('Saved');
		el.remove();
	});
});

describe('variant=line, for a menu', () => {
	it('is one line and a link, and the link asks for the gesture', () => {
		// The box belongs to a settings page. In a 17 rem menu it took 247 px,
		// most of that a sentence wrapping inside a column meant for an address.
		const { engine } = fakeEngine({
			status: {
				state: 'pending-download',
				severity: 'warn',
				actionable: true,
				action: 'download',
				labelKey: 'status.pendingDownload'
			}
		} as unknown as Partial<LocalStore['state']>);
		const el = mount(engine);
		el.variant = 'line';

		expect(q(el, '[part~="status-line"]')).not.toBeNull();
		expect(q(el, '[part~="status-row"]')).toBeNull(); // no box
		expect(q(el, '[part~="status-line-text"]')!.textContent).toBe('Changes to download');

		let asked: string | null = null;
		el.addEventListener('selfstore-status-action', (e) => {
			asked = (e as CustomEvent<{ action: string }>).detail.action;
		});
		const link = q(el, '[part~="status-action"]') as HTMLButtonElement;
		expect(link.getAttribute('part')).toContain('link'); // a link, not a button
		link.click();
		expect(asked).toBe('download');
		el.remove();
	});
});
