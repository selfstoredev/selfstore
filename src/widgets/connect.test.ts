// @vitest-environment happy-dom
/**
 * <selfstore-connect>: the element is a SKIN - the journey rules live in the
 * flow and its tests. Here we prove the skin: it renders the right step with
 * themable parts, wires clicks to the flow, keeps typing across re-renders,
 * speaks through labels (the i18n hook), and announces outcomes as events.
 */

import { describe, it, expect } from 'vitest';
import { createLocalStore } from '../persistence/store';
import type { CachedFile, KV, LocalCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { backup, type Snapshot } from '../selfstore';
import type { FlowHost } from '../flows/connect';
import { defineSelfstoreWidgets, SelfstoreConnectElement } from '../entries/widgets';

defineSelfstoreWidgets();

function memCache(): LocalCache {
	const kvMap = new Map<string, unknown>();
	let collections: Record<string, unknown[]> | undefined;
	const files = new Map<string, CachedFile>();
	const kv: KV = {
		async get<T>(k: string) {
			return kvMap.get(k) as T | undefined;
		},
		async set(k, v) {
			kvMap.set(k, v);
		},
		async del(k) {
			kvMap.delete(k);
		}
	};
	return {
		kv,
		async load() {
			return collections ? { collections, files: [...files.values()] } : null;
		},
		async saveCollections(c) {
			collections = c;
		},
		async saveFiles(list) {
			files.clear();
			for (const f of list) files.set(f.id, f);
		},
		async clear() {
			kvMap.clear();
			collections = undefined;
			files.clear();
		}
	};
}

function fakeTarget(initialRemote: Blob | null = null) {
	let remote = initialRemote;
	const target: BackupTarget = {
		kind: 'drive',
		label: 'Fake Drive',
		async save(b) {
			remote = b;
			return null;
		},
		async load() {
			return remote;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {
			/* nothing */
		}
	};
	return { target };
}

function makeHost(initial: Record<string, unknown[]> = {}) {
	const app = { collections: structuredClone(initial) };
	const cache = memCache();
	const engine = createLocalStore({
		app: 'widget-test',
		schemaVersion: 1,
		gather: (): Snapshot => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {}) as Record<string, unknown[]>;
		},
		cache
	});
	const host: FlowHost = { engine, kv: cache.kv, backupName: 'widget-test.zip' };
	return { app, engine, host };
}

async function waitFor<T>(probe: () => T | null | undefined | false, ms = 3000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const got = probe();
		if (got) return got;
		if (Date.now() - t0 > ms) throw new Error('waitFor: timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

function mount(): SelfstoreConnectElement {
	const el = document.createElement('selfstore-connect') as SelfstoreConnectElement;
	document.body.append(el);
	return el;
}

const q = (el: HTMLElement, sel: string): HTMLElement | null =>
	el.shadowRoot!.querySelector<HTMLElement>(sel);

describe('selfstore-connect: choosing', () => {
	it('renders the offered destinations as themable cards and connects on click', async () => {
		const { host, engine } = makeHost({ todos: [{ id: 't1', text: 'x' }] });
		await engine.init();
		const t = fakeTarget();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => t.target };

		const card = await waitFor(() => q(el, 'button[part="card"][data-kind="drive"]'));
		expect(q(el, '[part="title"]')!.textContent).toBe('Where should we save your data?');

		const done = new Promise<CustomEvent>((res) =>
			el.addEventListener('selfstore-connected', (e) => res(e as CustomEvent), { once: true })
		);
		card.click();
		const evt = await done;
		expect(evt.detail.outcome).toBe('started');
		expect(engine.state.targetKind).toBe('drive');
		await waitFor(() => q(el, '[part~="status-ok"]'));
		el.remove();
	});

	it('a file target in object form renders one card with the two gestures', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget();
		const el = mount();
		el.store = host;
		// Custom connectors on both gestures: no browser picker involved, and the
		// open gesture must run its connector, not create's.
		let opened = 0;
		el.targets = {
			file: {
				create: async () => null,
				open: async () => {
					opened++;
					return t.target;
				}
			}
		};

		await waitFor(() => q(el, '[part="card"][data-kind="file"]'));
		const createBtn = q(el, '[data-kind="file"] button[data-action="create"]');
		const openBtn = q(el, '[data-kind="file"] button[data-action="open"]');
		expect(createBtn).not.toBeNull();
		expect(openBtn).not.toBeNull();
		expect(createBtn!.textContent).toBe('New backup');
		expect(openBtn!.textContent).toBe('Load an existing file');

		openBtn!.click();
		await waitFor(() => q(el, '[part~="status-ok"]'));
		expect(opened).toBe(1);
		el.remove();
	});

	it('an advanced destination renders as a discreet link, not a card', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => null, webdav: true };
		el.advanced = ['webdav'];

		await waitFor(() => q(el, 'button[part="card"][data-kind="drive"]'));
		expect(q(el, '[part="card"][data-kind="webdav"]')).toBeNull();
		const link = q(el, 'button[part~="advanced-link"][data-kind="webdav"]');
		expect(link).not.toBeNull();
		expect(link!.textContent).toBe('My own server (WebDAV)');

		// The same journey: the link opens the WebDAV form step.
		link!.click();
		await waitFor(() => q(el, 'input[data-keep="wd-url"]'));
		el.remove();
	});

	it('offers configured WebDAV presets that pre-fill the URL field', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => null, webdav: true };
		el.advanced = ['webdav'];
		el.webdavPresets = [
			{
				id: 'kdrive',
				label: 'kDrive',
				url: 'https://connect.example.test/dav',
				help: 'Provider help'
			},
			{ id: 'cozy', label: 'Cozy', url: 'https://cozy.example.test/dav' }
		];

		// Open the WebDAV form.
		const link = await waitFor(() => q(el, 'button[part~="advanced-link"][data-kind="webdav"]'));
		link!.click();
		await waitFor(() => q(el, 'input[data-keep="wd-url"]'));

		// The presets render as buttons in order.
		const presets = [
			...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button[part~="preset"]')
		];
		expect(presets.length).toBe(2);
		expect(presets[0].getAttribute('data-preset')).toBe('kdrive');
		expect(presets[0].textContent).toBe('kDrive');
		expect(presets[0].getAttribute('title')).toBe('Provider help');

		// Picking one fills the URL field, leaving the rest to the user.
		presets[0].click();
		const url = q(el, 'input[data-keep="wd-url"]') as HTMLInputElement;
		expect(url.value).toBe('https://connect.example.test/dav');
		el.remove();
	});

	it('shows no preset row when none are configured', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { webdav: true };
		el.advanced = ['webdav'];
		const link = await waitFor(() => q(el, 'button[part~="advanced-link"][data-kind="webdav"]'));
		link!.click();
		await waitFor(() => q(el, 'input[data-keep="wd-url"]'));
		expect(q(el, 'button[part~="preset"]')).toBeNull();
		el.remove();
	});

	it('a picked preset flags active and reveals its help line and sign-up link', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { webdav: true };
		el.advanced = ['webdav'];
		el.webdavPresets = [
			{
				id: 'host',
				label: 'My Host',
				url: 'https://dav.example.test',
				help: 'The app password lives in your account settings.',
				helpUrl: 'https://example.test/help',
				signupUrl: 'https://example.test/signup'
			}
		];

		const link = await waitFor(() => q(el, 'button[part~="advanced-link"][data-kind="webdav"]'));
		link!.click();
		await waitFor(() => q(el, 'input[data-keep="wd-url"]'));

		// Nothing provider-specific until a preset is picked.
		expect(q(el, '[part~="webdav-note"]')).toBeNull();
		expect(q(el, '[part~="webdav-signup"]')).toBeNull();

		// A username typed before picking must survive the pick (kept fields).
		const user = q(el, 'input[data-keep="wd-user"]') as HTMLInputElement;
		user.value = 'alice';
		user.dispatchEvent(new Event('input'));

		(q(el, 'button[part~="preset"]') as HTMLButtonElement).click();

		// URL pre-filled, chip flagged active, guidance + links surfaced.
		const url = (await waitFor(() => q(el, 'input[data-keep="wd-url"]'))) as HTMLInputElement;
		expect(url.value).toBe('https://dav.example.test');
		expect(q(el, '[part~="preset-on"]')).not.toBeNull();
		expect(
			(q(el, 'button[part~="preset"]') as HTMLButtonElement).getAttribute('aria-pressed')
		).toBe('true');

		expect(q(el, '[part~="webdav-note"]')!.textContent).toContain('app password lives');
		expect((q(el, 'a[part~="webdav-help"]') as HTMLAnchorElement).getAttribute('href')).toBe(
			'https://example.test/help'
		);
		const signup = q(el, 'a[part~="webdav-signup"]') as HTMLAnchorElement;
		expect(signup.getAttribute('href')).toBe('https://example.test/signup');
		expect(signup.textContent).toBe('Create an account');

		// The username typed before the pick is still there after the re-render.
		expect((q(el, 'input[data-keep="wd-user"]') as HTMLInputElement).value).toBe('alice');
		el.remove();
	});

	it('renders a per-destination icon when one is set, and nothing otherwise', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.icons = { drive: 'data:image/png;base64,iVBORw0KGgo=' };
		el.targets = { drive: async () => null, file: async () => null };

		await waitFor(() => q(el, 'button[part="card"]'));
		const driveIcon = q(el, '[data-kind="drive"] img[part~="icon"]');
		expect(driveIcon).not.toBeNull();
		expect(driveIcon!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
		expect(q(el, '[data-kind="file"] img[part~="icon"]')).toBeNull();
		el.remove();
	});

	it('speaks through labels: a partial override rewords, the rest stays EN', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => null };
		el.labels = { 'connect.title': 'Ou garder vos donnees ?' };

		await waitFor(() => q(el, 'button[part="card"]'));
		expect(q(el, '[part="title"]')!.textContent).toBe('Ou garder vos donnees ?');
		// The card subtitle still carries the EN default (partial merge).
		expect(q(el, '[part="sub"]')!.textContent).toBe('Available on all your devices');
		el.remove();
	});

	it('cancel during the popup wait announces itself and returns to choose', async () => {
		const { host, engine } = makeHost();
		let release!: (t: BackupTarget | null) => void;
		const gate = new Promise<BackupTarget | null>((r) => (release = r));
		const el = mount();
		el.store = host;
		el.targets = { drive: () => gate };

		(await waitFor(() => q(el, 'button[part="card"]'))).click();
		const cancelBtn = await waitFor(() => q(el, '[part~="status"] button'));
		const cancelled = new Promise<void>((res) =>
			el.addEventListener('selfstore-cancelled', () => res(), { once: true })
		);
		cancelBtn.click();
		await cancelled;
		await waitFor(() => q(el, 'button[part="card"]')); // back on choose
		release(fakeTarget().target); // the popup answers too late: dropped
		await new Promise((r) => setTimeout(r, 30));
		expect(engine.state.targetKind).toBe('device');
		el.remove();
	});
});

describe('selfstore-connect: never a dead end', () => {
	it('an error offers retry AND a working cancel (no trap)', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		// A connector that rejects drives the flow into the 'error' step.
		el.targets = {
			drive: async () => {
				throw new Error('boom');
			}
		};

		(await waitFor(() => q(el, 'button[part="card"]'))).click();
		await waitFor(() => q(el, '[part~="status-error"]'));
		// Two ways out: retry (back to choices) and cancel (dismiss). Never one.
		const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('[part~="row"] button');
		expect(buttons.length).toBe(2);

		const cancelled = new Promise<void>((res) =>
			el.addEventListener('selfstore-cancelled', () => res(), { once: true })
		);
		buttons[1].click();
		await cancelled;
		await waitFor(() => q(el, 'button[part="card"]')); // back on choose
		el.remove();
	});
});

describe('selfstore-connect: the password step', () => {
	it('asks before attaching, says "wrong password" in place, then opens', async () => {
		const blob = await backup({ collections: { todos: [{ id: 'a', text: 's' }] }, files: [] })
			.as('widget-test')
			.encryptedWith('right')
			.toBlob();
		const { host, engine, app } = makeHost();
		await engine.init();
		const t = fakeTarget(blob);
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => t.target };

		(await waitFor(() => q(el, 'button[part="card"]'))).click();
		const input = (await waitFor(() => q(el, 'input[data-keep="password"]'))) as HTMLInputElement;
		expect(engine.state.targetKind).toBe('device'); // nothing attached yet

		input.value = 'wrong';
		q(el, 'button[part~="button-primary"]')!.click();
		await waitFor(() => q(el, '[part="error-note"]'));
		expect(engine.state.targetKind).toBe('device'); // still untouched

		const again = q(el, 'input[data-keep="password"]') as HTMLInputElement;
		again.value = 'right';
		q(el, 'button[part~="button-primary"]')!.click();
		await waitFor(() => q(el, '[part~="status-ok"]'));
		expect(app.collections.todos).toEqual([{ id: 'a', text: 's' }]);
		el.remove();
	});

	it('the eye reveals then re-hides the typed value in place', async () => {
		const blob = await backup({ collections: { todos: [{ id: 'a', text: 's' }] }, files: [] })
			.as('widget-test')
			.encryptedWith('right')
			.toBlob();
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget(blob);
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => t.target };

		(await waitFor(() => q(el, 'button[part="card"]'))).click();
		const input = (await waitFor(() => q(el, 'input[data-keep="password"]'))) as HTMLInputElement;
		input.value = 'hunter2';
		expect(input.type).toBe('password');

		const eye = q(el, 'button[part~="eye"]') as HTMLButtonElement;
		eye.click();
		// Same input element, now shown: the typed value survived (no re-render).
		const shown = q(el, 'input[data-keep="password"]') as HTMLInputElement;
		expect(shown.type).toBe('text');
		expect(shown.value).toBe('hunter2');
		expect(eye.getAttribute('aria-pressed')).toBe('true');
		eye.click();
		expect((q(el, 'input[data-keep="password"]') as HTMLInputElement).type).toBe('password');
		el.remove();
	});

	it('forgotten-password escape: confirm (never one click), then start fresh', async () => {
		const blob = await backup({ collections: { todos: [{ id: 'a', text: 'secret' }] }, files: [] })
			.as('widget-test')
			.encryptedWith('right')
			.toBlob();
		const { host, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush();
		const t = fakeTarget(blob);
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => t.target };

		(await waitFor(() => q(el, 'button[part="card"]'))).click();
		await waitFor(() => q(el, 'input[data-keep="password"]'));

		// The escape is a discreet link; it asks to confirm before erasing.
		const forgot = q(el, 'button[part~="forgot-link"]') as HTMLButtonElement;
		expect(forgot.textContent).toBe('Forgot the password?');
		forgot.click();
		await waitFor(() => q(el, 'button[part~="button-danger"]'));
		expect(q(el, '[part~="warn-note"]')).not.toBeNull();

		// Back bails out of the confirmation, attaching nothing.
		const back = [
			...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('[part~="row"] button')
		].find((b) => b.textContent === 'Back')!;
		back.click();
		await waitFor(() => q(el, 'input[data-keep="password"]'));
		expect(engine.state.targetKind).toBe('device');

		// Re-open and confirm this time: the protected backup is overwritten.
		(q(el, 'button[part~="forgot-link"]') as HTMLButtonElement).click();
		const confirm = await waitFor(() => q(el, 'button[part~="button-danger"]'));
		const done = new Promise<CustomEvent>((res) =>
			el.addEventListener('selfstore-connected', (e) => res(e as CustomEvent), { once: true })
		);
		confirm.click();
		const evt = await done;
		expect(evt.detail.outcome).toBe('replaced');
		expect(engine.state.targetKind).toBe('drive');
		el.remove();
	});
});

describe('selfstore-connect: the offer is the host to shape', () => {
	it('renders the destinations in the order the targets object wrote them', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { file: async () => null, drive: async () => null };

		await waitFor(() => q(el, 'button[part="card"]'));
		const kinds = Array.from(el.shadowRoot!.querySelectorAll('button[part="card"]')).map((c) =>
			c.getAttribute('data-kind')
		);
		expect(kinds).toEqual(['file', 'drive']);
		el.remove();
	});

	it('recommended badges exactly one card, and only while set', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => null, file: async () => null };
		el.setAttribute('recommended', 'file');

		const tag = await waitFor(() => q(el, '[data-kind="file"] [part="tag"]'));
		expect(tag.textContent).toBe('Recommended');
		expect(q(el, '[data-kind="drive"] [part="tag"]')).toBeNull();

		el.recommended = null;
		expect(q(el, '[part="tag"]')).toBeNull();
		el.remove();
	});

	it('an empty title label hides the heading, the cards stay', async () => {
		const { host } = makeHost();
		const el = mount();
		el.store = host;
		el.targets = { drive: async () => null };
		el.labels = { 'connect.title': '' };

		await waitFor(() => q(el, 'button[part="card"]'));
		expect(q(el, '[part="stack"] > [part="title"]')).toBeNull();
		el.remove();
	});
});
