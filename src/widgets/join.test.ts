// @vitest-environment happy-dom
/**
 * <selfstore-join>: the invitation skin over joinFlow. Preview before commit,
 * named outcomes rendered as their own messages, the account switch present
 * exactly when the engine offers one, events on the way out.
 */

import { describe, it, expect } from 'vitest';
import type { JoinEngine, JoinOutcome } from '../flows/join';
import { defineSelfstoreWidgets, SelfstoreJoinElement } from '../entries/widgets';

defineSelfstoreWidgets();

const LINK = 'https://x.test/join#k=abc';

function fakeEngine(outcome: JoinOutcome = 'joined'): JoinEngine {
	return {
		async preview() {
			return { label: 'Family wallet', from: 'ada@example.test', level: 'write' as const };
		},
		async join() {
			return outcome;
		}
	};
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

function mount(engine: JoinEngine, link = LINK): SelfstoreJoinElement {
	const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
	el.setAttribute('link', link);
	document.body.append(el);
	el.engine = engine;
	return el;
}

const q = (el: HTMLElement, sel: string): HTMLElement | null =>
	el.shadowRoot!.querySelector<HTMLElement>(sel);

describe('selfstore-join', () => {
	it('previews the invitation, joins on the explicit yes, announces it', async () => {
		const el = mount(fakeEngine());
		const accept = await waitFor(() => q(el, '[data-action="accept"]'));
		expect(q(el, '[part="title"]')!.textContent).toBe('Family wallet');
		expect(q(el, '[part="sub"]')!.textContent).toContain('ada@example.test');

		const joined = new Promise<void>((res) =>
			el.addEventListener('selfstore-joined', () => res(), { once: true })
		);
		accept.click();
		await joined;
		await waitFor(() => q(el, '[part~="status-ok"]'));
		el.remove();
	});

	it('renders mismatch as its own message, not an error', async () => {
		const el = mount(fakeEngine('mismatch'));
		(await waitFor(() => q(el, '[data-action="accept"]'))).click();
		await waitFor(() =>
			q(el, '[part="title"]')?.textContent?.includes('already follows another share')
		);
		expect(q(el, '[part~="status-error"]')).toBeNull();
		el.remove();
	});

	it('offers the account switch exactly when the engine does, and re-previews', async () => {
		const plain = mount(fakeEngine());
		await waitFor(() => q(plain, '[data-action="accept"]'));
		expect(q(plain, '[data-action="switch"]')).toBeNull();
		plain.remove();

		let account = 'first';
		const engine: JoinEngine = {
			async preview() {
				return { label: `wallet of ${account}` };
			},
			async join() {
				return 'joined';
			},
			async switchAccount() {
				account = 'second';
			}
		};
		const el = mount(engine);
		const switcher = await waitFor(() => q(el, '[data-action="switch"]'));
		switcher.click();
		await waitFor(() => q(el, '[part="title"]')?.textContent === 'wallet of second');
		el.remove();
	});

	it('speaks through labels', async () => {
		const el = mount(fakeEngine('no-invite'));
		el.labels = { 'join.noInvite': 'Invitation deja utilisee.' };
		(await waitFor(() => q(el, '[data-action="accept"]'))).click();
		await waitFor(() => q(el, '[part="title"]')?.textContent === 'Invitation deja utilisee.');
		el.remove();
	});

	it('variant="banner" folds ready into one line and still joins', async () => {
		const el = mount(fakeEngine());
		el.setAttribute('variant', 'banner');
		const banner = await waitFor(() => q(el, '[part~="banner"]'));
		expect(banner.querySelector('[part="title"]')!.textContent).toBe('Family wallet');
		// One line: the host page renders its own context around the widget.
		expect(q(el, '[part="sub"]')).toBeNull();
		expect(q(el, '[part="hint"]')).toBeNull();

		const joined = new Promise<void>((res) =>
			el.addEventListener('selfstore-joined', () => res(), { once: true })
		);
		q(el, '[data-action="accept"]')!.click();
		await joined;
		el.remove();
	});

	it('options reach the flow: a tiny deadline bites a hung join', async () => {
		const engine: JoinEngine = {
			async preview() {
				return { label: 'w' };
			},
			join: () => new Promise<JoinOutcome>(() => undefined) // never answers
		};
		const el = mount(engine);
		el.options = { deadlineMs: 30 };
		(await waitFor(() => q(el, '[data-action="accept"]'))).click();
		await waitFor(() => q(el, '[part~="status-error"]'));
		el.remove();
	});

	it('a join the user backed out of announces selfstore-cancelled and re-asks', async () => {
		const engine: JoinEngine = {
			async preview() {
				return { label: 'w' };
			},
			async join() {
				return null;
			}
		};
		const el = mount(engine);
		const cancelled = new Promise<void>((res) =>
			el.addEventListener('selfstore-cancelled', () => res(), { once: true })
		);
		(await waitFor(() => q(el, '[data-action="accept"]'))).click();
		await cancelled;
		await waitFor(() => q(el, '[data-action="accept"]')); // the question is live again
		expect(q(el, '[part~="status-error"]')).toBeNull();
		el.remove();
	});
});
