// @vitest-environment happy-dom
/**
 * <selfstore-storage>: the assembly, which is where every consumer made the
 * same mistakes. What is tested is the CHOICE - which screen is on at which
 * moment - and that everything else is derived from the store rather than asked
 * of the app.
 */

import { describe, it, expect } from 'vitest';
import type { FlowHost } from '../flows/connect';
import type { LocalStore } from '../persistence/store';
import { defineSelfstoreWidgets, SelfstoreStorageElement } from '../entries/widgets';

defineSelfstoreWidgets();

function fakeEngine(over: Partial<LocalStore['state']> = {}) {
	const subs = new Set<() => void>();
	const state = {
		ready: true,
		targetKind: 'drive',
		label: 'app.zip',
		encrypted: false,
		status: { state: 'saved', severity: 'ok', actionable: false, labelKey: 'status.saved' },
		...over
	};
	const engine = {
		state,
		subscribe(fn: () => void) {
			subs.add(fn);
			return () => subs.delete(fn);
		},
		async exportBlob() {
			return new Blob(['x']);
		},
		markDownloaded() {},
		async detachTarget() {}
	} as unknown as LocalStore;
	return {
		engine,
		tick: (next: Partial<typeof state>) => (Object.assign(state, next), subs.forEach((f) => f()))
	};
}

/** A simple store as the element sees it: ports plus what it can answer itself. */
function fakeStore(engine: LocalStore, extras: Record<string, unknown> = {}) {
	const flowHost: FlowHost = { engine, kv: {} as FlowHost['kv'], backupName: 'app.zip' };
	return { flowHost, ...extras } as unknown as Parameters<
		typeof Object.assign
	>[0] as unknown as SelfstoreStorageElement['store'];
}

function mount(store: SelfstoreStorageElement['store']): SelfstoreStorageElement {
	const el = document.createElement('selfstore-storage') as SelfstoreStorageElement;
	document.body.append(el);
	el.store = store;
	return el;
}

const child = (el: HTMLElement, tag: string): HTMLElement | null =>
	el.shadowRoot!.querySelector(tag);

describe('selfstore-storage - one element, the whole journey', () => {
	it('shows the first-run screen while there is no home, the panel once there is', () => {
		const { engine, tick } = fakeEngine({
			targetKind: 'device',
			status: {
				state: 'cache-only',
				severity: 'warn',
				actionable: true,
				action: 'choose-destination',
				labelKey: 'status.cacheOnly'
			}
		});
		const el = mount(fakeStore(engine));

		expect(child(el, 'selfstore-gate')).not.toBeNull();
		expect(child(el, 'selfstore-destination')).toBeNull();

		tick({
			targetKind: 'drive',
			status: { state: 'saved', severity: 'ok', actionable: false, labelKey: 'status.saved' }
		});

		expect(child(el, 'selfstore-gate')).toBeNull();
		expect(child(el, 'selfstore-destination')).not.toBeNull();
	});

	it('shows neither while the store is still loading', () => {
		// The mistake every consumer made: a store that has not settled has no
		// destination YET, which is not the same as having none.
		const { engine, tick } = fakeEngine({
			ready: false,
			targetKind: 'device',
			status: {
				state: 'cache-only',
				severity: 'warn',
				actionable: true,
				action: 'choose-destination',
				labelKey: 'status.cacheOnly'
			}
		});
		const el = mount(fakeStore(engine));

		expect((child(el, 'selfstore-gate') as { open?: boolean } | null)?.open).toBe(false);

		tick({ ready: true });
		expect((child(el, 'selfstore-gate') as { open?: boolean } | null)?.open).toBe(true);
	});

	it('takes the destinations, the resume card and the account FROM the store', () => {
		const { engine } = fakeEngine();
		const resume = { kind: 'drive', detail: 'someone@example.com', connect: async () => null };
		const el = mount(
			fakeStore(engine, {
				destinations: () => ({ drive: {}, file: true }),
				resumeOffer: () => resume,
				account: 'someone@example.com'
			})
		);

		// Nothing above was passed to the element: an app writes none of it.
		const panel = child(el, 'selfstore-destination') as HTMLElement & { account?: string | null };
		expect(panel.account).toBe('someone@example.com');
		// The panel renders in its OWN shadow root: what is asserted here is the
		// handover, not its rendering (that is the panel's own test).
		const gateless = child(el, 'selfstore-gate');
		expect(gateless).toBeNull();
	});

	it('lets a host override the offer without touching the rest', () => {
		const { engine } = fakeEngine({
			targetKind: 'device',
			status: {
				state: 'cache-only',
				severity: 'warn',
				actionable: true,
				action: 'choose-destination',
				labelKey: 'status.cacheOnly'
			}
		});
		const el = mount(fakeStore(engine, { destinations: () => ({ drive: {}, file: true }) }));

		el.targets = { file: true };

		const gate = child(el, 'selfstore-gate') as HTMLElement & { targets?: object };
		expect(Object.keys(gate.targets ?? {})).toEqual(['file']);
	});

	it('mounts the backups list only when the app manages several files', () => {
		const { engine } = fakeEngine();
		const el = mount(fakeStore(engine));
		expect(child(el, 'selfstore-backups')).toBeNull();

		// A manager stub complete enough for the list to render: what is asserted
		// is that the element MOUNTS it, not what it draws.
		el.manager = {
			subscribe: () => () => {},
			snapshot: {
				rows: [],
				registry: { personalFileId: null, shared: [] },
				busy: null,
				error: null
			},
			hydrate: async () => {},
			refresh: async () => {}
		} as never;

		expect(child(el, 'selfstore-backups')).not.toBeNull();
	});

	it('keeps the same child across a rerender, so a journey is never destroyed', () => {
		const { engine } = fakeEngine();
		const el = mount(fakeStore(engine));
		const first = child(el, 'selfstore-destination');

		el.icons = { drive: 'data:,' };

		expect(child(el, 'selfstore-destination')).toBe(first);
	});
});

describe('the knobs it forwards', () => {
	it('reads its attributes and passes the gate what it was told', () => {
		const { engine } = fakeEngine({
			targetKind: 'device',
			status: {
				state: 'cache-only',
				severity: 'warn',
				actionable: true,
				action: 'choose-destination',
				labelKey: 'status.cacheOnly'
			}
		});
		const el = document.createElement('selfstore-storage') as SelfstoreStorageElement;
		el.setAttribute('deferrable', 'false');
		el.setAttribute('recommended', 'file');
		document.body.append(el);
		el.store = fakeStore(engine);

		expect(el.deferrable).toBe(false);
		expect(el.recommended).toBe('file');
		const gate = child(el, 'selfstore-gate') as HTMLElement & {
			deferrable?: boolean;
			recommended?: string | null;
		};
		expect(gate.deferrable).toBe(false);
		expect(gate.recommended).toBe('file');
	});

	it('reads every knob back, and hands the veto to the panel', () => {
		const { engine } = fakeEngine();
		const el = mount(fakeStore(engine));
		const veto = (): boolean => false;

		el.confirmAction = veto;
		el.icons = { drive: 'data:,' };
		el.targets = { file: true };
		el.manager = null;

		expect(el.confirmAction).toBe(veto);
		expect(el.icons).toEqual({ drive: 'data:,' });
		expect(el.targets).toEqual({ file: true });
		expect(el.manager).toBeNull();
		expect(el.store).not.toBeNull();
		const panel = child(el, 'selfstore-destination') as HTMLElement & { confirmAction?: unknown };
		expect(panel.confirmAction).toBe(veto);
	});

	it('offers a file alone when the store cannot say what it offers', () => {
		// A hand-built FlowHost is not a simple store: no destinations() to ask.
		const { engine } = fakeEngine({
			targetKind: 'device',
			status: {
				state: 'cache-only',
				severity: 'warn',
				actionable: true,
				action: 'choose-destination',
				labelKey: 'status.cacheOnly'
			}
		});
		const el = mount({
			engine,
			kv: {} as FlowHost['kv'],
			backupName: 'app.zip'
		} as unknown as SelfstoreStorageElement['store']);

		const gate = child(el, 'selfstore-gate') as HTMLElement & { targets?: object };
		expect(Object.keys(gate.targets ?? {})).toEqual(['file']);
	});
});
