// @vitest-environment happy-dom
/**
 * <selfstore-account>: the header control. What is tested is what a header
 * promises - it names where the data goes, it says WHEN it was last written,
 * and it closes like a menu - plus the one gesture it performs itself: letting
 * a destination go, which is the only way this element can lose anything.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FlowHost } from '../flows/connect';
import type { LocalStore } from '../persistence/store';
import { defineSelfstoreWidgets, SelfstoreAccountElement } from '../entries/widgets';

defineSelfstoreWidgets();

const SAVED = { state: 'saved', severity: 'ok', actionable: false, labelKey: 'status.saved' };

function fakeEngine(over: Record<string, unknown> = {}) {
	const subs = new Set<() => void>();
	const detachTarget = vi.fn(async () => {});
	const state = {
		ready: true,
		targetKind: 'drive',
		label: 'app.zip',
		encrypted: false,
		lastSavedAt: Date.now(),
		status: SAVED,
		...over
	};
	const engine = {
		state,
		subscribe(fn: () => void) {
			subs.add(fn);
			return () => subs.delete(fn);
		},
		detachTarget
	} as unknown as LocalStore;
	return {
		engine,
		detachTarget,
		tick: (next: Record<string, unknown>) => (Object.assign(state, next), subs.forEach((f) => f()))
	};
}

function mount(engine: LocalStore, extras: Record<string, unknown> = {}): SelfstoreAccountElement {
	const el = document.createElement('selfstore-account') as SelfstoreAccountElement;
	document.body.append(el);
	el.store = {
		flowHost: { engine, kv: {} as FlowHost['kv'], backupName: 'app.zip' },
		...extras
	} as unknown as SelfstoreAccountElement['store'];
	return el;
}

const text = (el: SelfstoreAccountElement, part: string): string =>
	(el.shadowRoot!.querySelector(`[part~='${part}']`) as HTMLElement | null)?.textContent ?? '';
const btn = (el: SelfstoreAccountElement, part: string): HTMLButtonElement | null =>
	el.shadowRoot!.querySelector(`[part~='${part}']`);

describe('the trigger', () => {
	it('names the destination and carries the severity', () => {
		const { engine, tick } = fakeEngine();
		const el = mount(engine);

		expect(text(el, 'account-trigger')).toContain('Google Drive');
		expect(btn(el, 'account-trigger')!.getAttribute('part')).toContain('ok');

		tick({
			status: { state: 'needs-attention', severity: 'warn', actionable: true, action: 'reconnect' }
		});
		expect(btn(el, 'account-trigger')!.getAttribute('part')).toContain('warn');
	});

	it('falls back to the target own label when the kind has no shipped name', () => {
		const { engine } = fakeEngine({ targetKind: 'ipfs', label: 'my pinned set' });
		expect(text(mount(engine), 'account-trigger')).toContain('my pinned set');
	});

	it('stays inert until it is wired, rather than drawing an empty shell', () => {
		const el = document.createElement('selfstore-account') as SelfstoreAccountElement;
		document.body.append(el);
		expect(btn(el, 'account-trigger')).toBeNull();
	});
});

describe('the menu', () => {
	it('opens on the trigger and closes on a second press', () => {
		const el = mount(fakeEngine().engine);
		expect(btn(el, 'account-menu')).toBeNull();

		btn(el, 'account-trigger')!.click();
		expect(btn(el, 'account-menu')).not.toBeNull();
		expect(btn(el, 'account-trigger')!.getAttribute('aria-expanded')).toBe('true');

		btn(el, 'account-trigger')!.click();
		expect(btn(el, 'account-menu')).toBeNull();
	});

	it('closes on a press outside, and on Escape', () => {
		const el = mount(fakeEngine().engine);

		el.open = true;
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
		expect(el.open).toBe(false);

		el.open = true;
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(el.open).toBe(false);
	});

	it('stays open on a press inside it - shadow DOM retargets, the path does not', () => {
		const el = mount(fakeEngine().engine);
		el.open = true;

		btn(el, 'account-card')!.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, composed: true })
		);

		expect(el.open).toBe(true);
	});

	it('stops listening once it leaves the page', () => {
		const el = mount(fakeEngine().engine);
		el.open = true;
		el.remove();

		expect(el.open).toBe(false);
		// No listener left behind: a removed element must not answer a keystroke.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(el.open).toBe(false);
	});
});

describe('the card', () => {
	it('names who holds the backup, taken from the store', () => {
		const el = mount(fakeEngine().engine, { account: 'someone@example.com' });
		el.open = true;
		expect(text(el, 'account-mail')).toBe('someone@example.com');
	});

	it('says WHEN it was last saved, and keeps that line to itself', () => {
		const { engine, tick } = fakeEngine({ lastSavedAt: Date.now() });
		const el = mount(engine);
		el.open = true;

		expect(text(el, 'account-line')).toBe('Saved just now');

		tick({ lastSavedAt: Date.now() - 3 * 60_000 });
		expect(text(el, 'account-line')).toBe('Saved 3 minutes ago');

		tick({ lastSavedAt: Date.now() - 5 * 3600_000 });
		expect(text(el, 'account-line')).toBe('Saved 5 hours ago');
	});

	it('speaks the page language, for its own words and for the duration', () => {
		document.documentElement.lang = 'fr';
		const el = mount(fakeEngine({ lastSavedAt: Date.now() - 3 * 60_000 }).engine);
		el.open = true;

		expect(text(el, 'account-line')).toBe('Enregistré il y a 3 minutes');
		expect(text(el, 'account-item')).toBe('Paramètres');
		document.documentElement.lang = '';
	});

	it('hands anything that needs attention to the status row, wording nothing itself', () => {
		const { engine, tick } = fakeEngine();
		const el = mount(engine);
		el.open = true;
		expect(el.shadowRoot!.querySelector('selfstore-status')).toBeNull();

		tick({
			status: {
				state: 'needs-attention',
				severity: 'warn',
				actionable: true,
				action: 'reconnect',
				labelKey: 'status.needsAttention'
			}
		});

		// The row owns both the wording and the button that resolves it.
		expect(el.shadowRoot!.querySelector('selfstore-status')).not.toBeNull();
		expect(el.shadowRoot!.querySelector("[part~='account-line']")).toBeNull();
	});

	it('lets a host that reworded "saved" keep its own sentence', () => {
		const el = mount(fakeEngine().engine);
		el.labels = { 'status.saved': 'Tout est en ordre' };
		el.open = true;

		expect(el.shadowRoot!.querySelector('selfstore-status')).not.toBeNull();
	});
});

describe('the two decisions', () => {
	it('asks for the settings and closes, leaving the route to the host', () => {
		const el = mount(fakeEngine().engine);
		const asked = vi.fn();
		el.addEventListener('selfstore-account-settings', asked);
		el.open = true;

		btn(el, 'account-card')!.click();

		expect(asked).toHaveBeenCalledOnce();
		expect(el.open).toBe(false);
	});

	it('changes backup by letting the destination go - the first-run screen takes over', async () => {
		const { engine, detachTarget } = fakeEngine();
		const el = mount(engine);
		el.open = true;

		btn(el, 'account-change')!.click();
		await vi.waitFor(() => expect(detachTarget).toHaveBeenCalledOnce());
		expect(el.open).toBe(false);
	});

	it('respects a veto, and reads a throwing one as a no', async () => {
		const { engine, detachTarget } = fakeEngine();
		const el = mount(engine);

		el.confirmAction = vi.fn(() => false);
		el.open = true;
		btn(el, 'account-change')!.click();
		await vi.waitFor(() =>
			expect(el.confirmAction).toHaveBeenCalledWith({
				type: 'detach',
				label: 'app.zip'
			})
		);
		expect(detachTarget).not.toHaveBeenCalled();

		el.confirmAction = () => {
			throw new Error('undecided');
		};
		el.open = true;
		btn(el, 'account-change')!.click();
		await Promise.resolve();
		expect(detachTarget).not.toHaveBeenCalled();
	});
});

describe('the knobs', () => {
	it('reads back what it was given, and shows the destination glyph', () => {
		const el = mount(fakeEngine().engine);
		el.icons = { drive: 'data:,' };
		el.account = 'held@example.com';
		el.open = true;

		expect(el.icons).toEqual({ drive: 'data:,' });
		expect(el.account).toBe('held@example.com');
		expect(el.store).not.toBeNull();
		expect(el.confirmAction).toBeNull();
		expect(el.shadowRoot!.querySelector("[part~='account-logo']")).not.toBeNull();
	});

	it('prefers the store account once the host clears its own', () => {
		const el = mount(fakeEngine().engine, { account: 'store@example.com' });
		el.account = 'host@example.com';
		expect(el.account).toBe('host@example.com');

		el.account = null;
		expect(el.account).toBe('store@example.com');
	});
});

describe('a change that fails says so', () => {
	it('reopens the menu with the error, where the press happened', async () => {
		// A failure that closed the menu behind it is indistinguishable from a
		// button that does nothing - which is what a user reports, and what makes
		// them press it again.
		const { engine } = fakeEngine();
		(engine as unknown as { detachTarget: () => Promise<void> }).detachTarget = () =>
			Promise.reject(new Error('nope'));
		const el = mount(engine);
		el.open = true;

		btn(el, 'account-change')!.click();
		await vi.waitFor(() =>
			expect(el.shadowRoot!.querySelector("[part~='account-error']")).not.toBeNull()
		);

		expect(el.open).toBe(true);
		expect(el.shadowRoot!.querySelector("[part~='account-error']")!.textContent).toBe(
			'Something went wrong.'
		);
	});
});

describe('a state that needs a gesture', () => {
	it('sits under the card, on one line, not in the column meant for an address', () => {
		// Inside the card's text column the notice wrapped in 167 px and became a
		// 247 px box in a 395 px menu. It is a line now, across the menu.
		const { engine, tick } = fakeEngine();
		const el = mount(engine);
		el.open = true;
		expect(el.shadowRoot!.querySelector("[part~='account-status']")).toBeNull();

		tick({
			status: {
				state: 'pending-download',
				severity: 'warn',
				actionable: true,
				action: 'download',
				labelKey: 'status.pendingDownload'
			}
		});

		const line = el.shadowRoot!.querySelector("[part~='account-status']") as HTMLElement;
		expect(line).not.toBeNull();
		expect(line.getAttribute('variant')).toBe('line');
		// Under the card, not inside it.
		expect(el.shadowRoot!.querySelector("[part~='account-card']")!.contains(line)).toBe(false);
	});
});

describe('what the trigger says', () => {
	it('states the condition when an app has one destination to offer', () => {
		// Naming the place is right when there is a choice. It says nothing at all
		// where a file is the only thing it could ever be - such an app states a
		// condition instead, which is the part that changes.
		const { engine } = fakeEngine({ targetKind: 'file', label: 'cabinet.zip' });
		const el = mount(engine);
		expect(text(el, 'account-trigger')).toContain('A file on this device');

		el.trigger = 'status';
		expect(el.trigger).toBe('status');
		const said = el.shadowRoot!.querySelector("[part~='account-trigger-status']") as HTMLElement & {
			shadowRoot: ShadowRoot;
		};
		expect(said).not.toBeNull();
		expect(said.getAttribute('variant')).toBe('line');
		// The state comes from the status widget's own words: the two surfaces
		// cannot drift.
		expect(said.shadowRoot.querySelector("[part~='status-line-text']")!.textContent).toContain(
			'Saved'
		);
	});
});

describe('the trigger as an attribute', () => {
	it('reads it from the markup, and follows a later change', () => {
		// A plain-HTML host writes trigger="status" and never touches a property.
		const { engine } = fakeEngine({ targetKind: 'file', label: 'cabinet.zip' });
		const el = document.createElement('selfstore-account') as SelfstoreAccountElement;
		el.setAttribute('trigger', 'status');
		document.body.append(el);
		el.store = {
			flowHost: { engine, kv: {} as FlowHost['kv'], backupName: 'app.zip' }
		} as unknown as SelfstoreAccountElement['store'];

		expect(el.trigger).toBe('status');
		expect(el.shadowRoot!.querySelector("[part~='account-trigger-status']")).not.toBeNull();

		el.setAttribute('trigger', 'destination');
		expect(el.trigger).toBe('destination');
		expect(el.shadowRoot!.querySelector("[part~='account-trigger-status']")).toBeNull();
		el.remove();
	});
});
