// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import type { ShareEngine, ShareLinkInfo, ShareMemberInfo } from '../flows/share';
import { defineSelfstoreWidgets, SelfstoreShareElement } from '../entries/widgets';

defineSelfstoreWidgets();

function fakeEngine(initial: { links?: ShareLinkInfo[]; members?: ShareMemberInfo[] } = {}) {
	const state = { links: initial.links ?? [], members: initial.members ?? [] };
	const engine: ShareEngine = {
		async list() {
			return { links: [...state.links], members: [...state.members] };
		},
		async createLink(opts) {
			const id = `l${state.links.length + 1}`;
			const l: ShareLinkInfo = { id, url: `https://x.test/j#${id}`, ...opts };
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

describe('SelfstoreShareElement.flow getter', () => {
	let el: SelfstoreShareElement;

	beforeEach(() => {
		el = document.createElement('selfstore-share') as SelfstoreShareElement;
		document.body.append(el);
	});

	it('returns null before engine is set', () => {
		expect(el.flow).toBeNull();
	});

	it('returns ShareFlow instance after engine is set and connected', async () => {
		const { engine } = fakeEngine();
		el.engine = engine;
		await Promise.resolve();
		const flow = el.flow;
		expect(flow).not.toBeNull();
		expect(typeof flow?.subscribe).toBe('function');
		expect(typeof flow?.createLink).toBe('function');
		expect(typeof flow?.revokeLink).toBe('function');
	});

	it('returns same flow instance on repeated access', async () => {
		const { engine } = fakeEngine();
		el.engine = engine;
		await Promise.resolve();
		const first = el.flow;
		const second = el.flow;
		expect(first).toBe(second);
	});

	it('returns updated flow when options change', async () => {
		const { engine } = fakeEngine();
		el.engine = engine;
		await Promise.resolve();
		const firstFlow = el.flow;
		el.options = { deadlineMs: 5000 };
		await Promise.resolve();
		const secondFlow = el.flow;
		expect(secondFlow).not.toBe(firstFlow);
	});
});
