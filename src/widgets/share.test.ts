// @vitest-environment happy-dom
/**
 * <selfstore-share>: the panel skin over shareFlow. The flow's rules are
 * proven in flows/share.test.ts; here we prove the rendering contract -
 * lists with parts, actions wired, self never removable, labels, events.
 */

import { describe, it, expect } from 'vitest';
import type { ShareEngine, ShareLinkInfo, ShareMemberInfo } from '../flows/share';
import { defineSelfstoreWidgets, SelfstoreShareElement } from '../entries/widgets';

defineSelfstoreWidgets();

const link = (id: string): ShareLinkInfo => ({ id, url: `https://x.test/j#${id}`, level: 'write' });
const member = (id: string, self = false, owner = false): ShareMemberInfo => ({
	id,
	self,
	owner,
	label: id
});

function fakeEngine(initial: { links?: ShareLinkInfo[]; members?: ShareMemberInfo[] } = {}) {
	const state = { links: initial.links ?? [], members: initial.members ?? [] };
	const engine: ShareEngine = {
		async list() {
			return { links: [...state.links], members: [...state.members] };
		},
		async createLink(opts) {
			const l = { ...link(`l${state.links.length + 1}`), ...opts };
			state.links.push(l);
			return l;
		},
		async revokeLink(id) {
			state.links = state.links.filter((l) => l.id !== id);
		},
		async removeMember(id) {
			state.members = state.members.filter((m) => m.id !== id);
		}
	};
	return { engine, state };
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

function mount(engine: ShareEngine): SelfstoreShareElement {
	const el = document.createElement('selfstore-share') as SelfstoreShareElement;
	document.body.append(el);
	el.engine = engine;
	return el;
}

const qa = (el: HTMLElement, sel: string): HTMLElement[] =>
	Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>(sel));

describe('selfstore-share', () => {
	it('renders links and members as themable cards; you are never removable', async () => {
		const { engine } = fakeEngine({
			links: [link('l1')],
			members: [member('me', true, true), member('ada')]
		});
		const el = mount(engine);

		await waitFor(() => qa(el, '[data-member]').length === 2);
		expect(qa(el, '[data-link]').length).toBe(1);
		const me = el.shadowRoot!.querySelector('[data-member="me"]')!;
		const ada = el.shadowRoot!.querySelector('[data-member="ada"]')!;
		expect(me.querySelector('[data-action="remove"]')).toBeNull(); // never yourself
		expect(ada.querySelector('[data-action="remove"]')).not.toBeNull();
		el.remove();
	});

	it('creates a link on click and announces it', async () => {
		const { engine } = fakeEngine();
		const el = mount(engine);
		const btn = await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLElement>('[data-action="create-write"]:not([disabled])')
		);
		const created = new Promise<CustomEvent>((res) =>
			el.addEventListener('selfstore-link-created', (e) => res(e as CustomEvent), { once: true })
		);
		btn.click();
		const evt = await created;
		expect(evt.detail.link.url).toContain('https://x.test/j#');
		await waitFor(() => qa(el, '[data-link]').length === 1);
		el.remove();
	});

	it('revoke removes the row only through the engine, and the row survives a failure', async () => {
		const { engine } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		engine.revokeLink = async () => {
			throw new Error('relay down');
		};
		const el = mount(engine);
		const revoke = await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLElement>('[data-action="revoke"]')
		);
		revoke.click();
		await waitFor(() => el.shadowRoot!.querySelector('[part="error-note"]'));
		expect(qa(el, '[data-link]').length).toBe(1); // still there, honestly
		el.remove();
	});

	it('speaks through labels', async () => {
		const { engine } = fakeEngine();
		const el = mount(engine);
		el.labels = { 'share.title': 'Partage' };
		await waitFor(() => el.shadowRoot!.querySelector('[part="title"]')?.textContent === 'Partage');
		el.remove();
	});
});

describe('selfstore-share: every knob optional, full panel by default', () => {
	it('levels narrows the offer: levels="read" only proposes a view link', async () => {
		const { engine, state } = fakeEngine();
		const el = mount(engine);
		el.levels = ['read'];
		const btn = await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLElement>('[data-action="create-read"]:not([disabled])')
		);
		expect(el.shadowRoot!.querySelector('[data-action="create-write"]')).toBeNull();
		btn.click();
		await waitFor(() => state.links.length === 1);
		expect(state.links[0].level).toBe('read');
		el.remove();
	});

	it('one link per level: a live link retires its create button', async () => {
		const { engine } = fakeEngine({ links: [link('l1')] }); // l1 is a write link
		const el = mount(engine);
		await waitFor(() => qa(el, '[data-link]').length === 1);
		expect(el.shadowRoot!.querySelector('[data-action="create-write"]')).toBeNull();
		expect(el.shadowRoot!.querySelector('[data-action="create-read"]')).not.toBeNull();
		el.remove();
	});

	it('with-create="off" and with-members="off" hide their sections', async () => {
		const { engine } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		const el = mount(engine);
		el.setAttribute('with-create', 'off');
		el.setAttribute('with-members', 'off');
		await waitFor(() => qa(el, '[data-link]').length === 1);
		expect(el.shadowRoot!.querySelector('[data-action="create-read"]')).toBeNull();
		expect(el.shadowRoot!.querySelector('[data-action="create-write"]')).toBeNull();
		expect(qa(el, '[data-member]').length).toBe(0);
		el.remove();
	});

	it('confirmAction vetoes a revoke; a clear yes lets it through', async () => {
		const { engine, state } = fakeEngine({ links: [link('l1')] });
		const el = mount(engine);
		let allow = false;
		const asked: string[] = [];
		el.confirmAction = async (a) => {
			asked.push('id' in a ? `${a.type}:${a.id}` : a.type);
			return allow;
		};
		const revoke = await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLElement>('[data-action="revoke"]:not([disabled])')
		);
		revoke.click();
		await waitFor(() => asked.length === 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(qa(el, '[data-link]').length).toBe(1); // vetoed: the row stays
		expect(state.links.length).toBe(1); // and the engine was never asked

		allow = true;
		el.shadowRoot!.querySelector<HTMLElement>('[data-action="revoke"]')!.click();
		await waitFor(() => qa(el, '[data-link]').length === 0);
		expect(asked).toEqual(['revoke:l1', 'revoke:l1']);
		el.remove();
	});

	it('the stop action exists only when the engine can end the share', async () => {
		const bare = fakeEngine({ members: [member('me', true), member('ada')] });
		const el = mount(bare.engine);
		await waitFor(() => qa(el, '[data-member]').length === 2);
		expect(el.shadowRoot!.querySelector('[data-action="stop"]')).toBeNull();
		el.remove();

		const { engine, state } = fakeEngine({
			links: [link('l1')],
			members: [member('me', true), member('ada')]
		});
		let ended = 0;
		engine.revokeAll = async () => {
			ended++;
			state.links = [];
			state.members = [];
		};
		const el2 = mount(engine);
		const stopped = new Promise<void>((res) =>
			el2.addEventListener('selfstore-share-stopped', () => res(), { once: true })
		);
		const stop = await waitFor(() =>
			el2.shadowRoot!.querySelector<HTMLElement>('[data-action="stop"]:not([disabled])')
		);
		stop.click();
		await stopped;
		expect(ended).toBe(1);
		await waitFor(() => qa(el2, '[data-link]').length === 0);
		el2.remove();
	});

	it('the stop action waits for company: alone in the share, it stays hidden', async () => {
		const { engine } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		engine.revokeAll = async () => undefined;
		const el = mount(engine);
		await waitFor(() => qa(el, '[data-member]').length === 1);
		expect(el.shadowRoot!.querySelector('[data-action="stop"]')).toBeNull();
		el.remove();
	});

	it('confirmAction vetoes the stop like every destructive gesture', async () => {
		const { engine } = fakeEngine({
			links: [link('l1')],
			members: [member('me', true), member('ada')]
		});
		let ended = 0;
		engine.revokeAll = async () => {
			ended++;
		};
		const el = mount(engine);
		const asked: string[] = [];
		el.confirmAction = async (a) => {
			asked.push(a.type);
			return false;
		};
		const stop = await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLElement>('[data-action="stop"]:not([disabled])')
		);
		stop.click();
		await waitFor(() => asked.length === 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(asked).toEqual(['stop']);
		expect(ended).toBe(0); // vetoed: the engine was never asked
		expect(qa(el, '[data-link]').length).toBe(1);
		el.remove();
	});

	it('qrProvider dresses each link with its QR image', async () => {
		const { engine } = fakeEngine({ links: [link('l1')] });
		const el = mount(engine);
		el.qrProvider = async (url) => `data:image/gif;qr=${encodeURIComponent(url)}`;
		const img = (await waitFor(() =>
			el.shadowRoot!.querySelector<HTMLImageElement>('img[part="qr"]')
		)) as HTMLImageElement;
		expect(img.getAttribute('src')).toBe(
			`data:image/gif;qr=${encodeURIComponent('https://x.test/j#l1')}`
		);
		el.remove();
	});

	it('an empty heading label removes the heading', async () => {
		const { engine } = fakeEngine();
		const el = mount(engine);
		el.labels = { 'share.title': '' };
		await waitFor(() => el.shadowRoot!.querySelector('[data-action="create-write"]'));
		expect(el.shadowRoot!.querySelector('[part="stack"] > [part="title"]')).toBeNull();
		el.remove();
	});

	it('options reach the flow: a tiny deadline turns a hung listing stale', async () => {
		const engine: ShareEngine = {
			list: () => new Promise<{ links: ShareLinkInfo[]; members: ShareMemberInfo[] }>(() => undefined),
			async createLink(opts) {
				return { ...link('l1'), ...opts };
			},
			async revokeLink() {
				/* nothing */
			}
		};
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		document.body.append(el);
		el.options = { deadlineMs: 30 };
		el.engine = engine;
		await waitFor(() =>
			qa(el, '[part="hint"]').some((n) => n.textContent?.includes('hiccup'))
		);
		el.remove();
	});
});
