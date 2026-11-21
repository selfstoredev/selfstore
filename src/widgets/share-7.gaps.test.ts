// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShareEngine, ShareLinkInfo } from '../flows/share';
import { defineSelfstoreWidgets, SelfstoreShareElement } from '../entries/widgets';

defineSelfstoreWidgets();

const link = (id: string): ShareLinkInfo => ({ id, url: `https://x.test/j#${id}`, level: 'write' });

function fakeEngine(initial: { links?: ShareLinkInfo[] } = {}) {
	const state = { links: initial.links ?? [] };
	return {
		engine: {
			async list() {
				return { links: [...state.links], members: [] };
			},
			async createLink(opts: { level: 'read' | 'write' }) {
				const l = { ...link(`l${state.links.length + 1}`), ...opts };
				state.links.push(l);
				return l;
			},
			async revokeLink(id: string) {
				state.links = state.links.filter((l) => l.id !== id);
			}
		} satisfies ShareEngine,
		state
	};
}

describe('SelfstoreShareElement copy', () => {
	let el: SelfstoreShareElement;
	let clipboardWrite: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		clipboardWrite = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: clipboardWrite },
			configurable: true
		});

		el = document.createElement('selfstore-share') as SelfstoreShareElement;
		document.body.append(el);
		const { engine } = fakeEngine({ links: [link('abc123')] });
		el.engine = engine;
	});

	it('sets copiedId, emits event, writes clipboard, rerenders, then clears after timeout', async () => {
		const emitted: Array<{ url: string }> = [];
		el.addEventListener('selfstore-link-copied', (e: Event) =>
			emitted.push((e as CustomEvent).detail)
		);

		const copyBtn = el.shadowRoot!.querySelector('button[data-action="copy"]') as HTMLButtonElement;
		copyBtn.click();

		expect(el.shadowRoot!.querySelector('button[data-action="copy"]')?.textContent).toBe('Copied');
		expect(emitted).toEqual([{ url: 'https://x.test/j#abc123' }]);
		expect(clipboardWrite).toHaveBeenCalledOnce();
		expect(clipboardWrite).toHaveBeenCalledWith('https://x.test/j#abc123');

		await vi.advanceTimersByTimeAsync(1500);

		expect(el.shadowRoot!.querySelector('button[data-action="copy"]')?.textContent).toBe('Copy');
	});
});
