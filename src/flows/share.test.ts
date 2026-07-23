/**
 * shareFlow: the panel rules. The big one - a transient failure never blanks
 * the panel - exists because a member who once saw an empty editor list
 * revoked a healthy share in panic.
 */

import { describe, it, expect } from 'vitest';
import { shareFlow, type ShareEngine, type ShareLinkInfo, type ShareMemberInfo } from './share';
import type { FlowStore } from './machine';

async function until<T>(flow: FlowStore<T>, pred: (s: T) => boolean, ms = 3000): Promise<T> {
	if (pred(flow.snapshot)) return flow.snapshot;
	return new Promise<T>((resolve, reject) => {
		let unsub: (() => void) | null = null;
		const timer = setTimeout(() => {
			unsub?.();
			reject(new Error(`until: timed out on ${JSON.stringify(flow.snapshot)}`));
		}, ms);
		unsub = flow.subscribe((s) => {
			if (!pred(s)) return;
			clearTimeout(timer);
			unsub?.();
			resolve(s);
		});
	});
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const link = (id: string): ShareLinkInfo => ({ id, url: `https://x.test/j#${id}`, level: 'write' });
const member = (id: string, self = false): ShareMemberInfo => ({ id, self });

/** A well-behaved in-memory engine; individual tests break specific methods. */
function fakeEngine(initial: { links?: ShareLinkInfo[]; members?: ShareMemberInfo[] } = {}) {
	const state = {
		links: initial.links ?? [],
		members: initial.members ?? [],
		listCalls: 0,
		createCalls: 0,
		removeCalls: 0
	};
	const engine: ShareEngine = {
		async list() {
			state.listCalls++;
			return { links: [...state.links], members: [...state.members] };
		},
		async createLink(opts) {
			state.createCalls++;
			const l = { ...link(`l${state.links.length + 1}`), ...opts };
			state.links.push(l);
			return l;
		},
		async revokeLink(id) {
			state.links = state.links.filter((l) => l.id !== id);
		},
		async removeMember(id) {
			state.removeCalls++;
			state.members = state.members.filter((m) => m.id !== id);
		}
	};
	return { engine, state };
}

describe('shareFlow: listing', () => {
	it('opens on the truth: lists right away', async () => {
		const { engine } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		const flow = shareFlow(engine);
		const s = await until(flow, (x) => x.busy === null);
		expect(s.links.map((l) => l.id)).toEqual(['l1']);
		expect(s.members.map((m) => m.id)).toEqual(['me']);
		expect(s.stale).toBe(false);
	});

	it('a transient listing failure keeps the last-known lists, flagged stale', async () => {
		const { engine, state } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		engine.list = async () => {
			throw new Error('offline');
		};
		await flow.refresh();
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']); // Not blanked
		expect(flow.snapshot.members.map((m) => m.id)).toEqual(['me']);
		expect(flow.snapshot.stale).toBe(true);
		expect(flow.snapshot.error?.code).toBe('TARGET_UNAVAILABLE');

		engine.list = async () => ({ links: [...state.links], members: [...state.members] });
		await flow.refresh();
		expect(flow.snapshot.stale).toBe(false);
		expect(flow.snapshot.error).toBeNull();
	});

	it('a listing that never answers becomes stale under the deadline, not a frozen panel', async () => {
		const { engine } = fakeEngine();
		engine.list = () => new Promise(() => undefined);
		const flow = shareFlow(engine, { deadlineMs: 30 });
		const s = await until(flow, (x) => x.stale);
		expect(s.busy).toBeNull();
		expect(s.error?.code).toBe('TARGET_UNAVAILABLE');
	});
});

describe('shareFlow: operations', () => {
	it('one operation at a time: a second createLink while one runs is refused', async () => {
		const { engine, state } = fakeEngine();
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		const gate = deferred<ShareLinkInfo>();
		engine.createLink = () => {
			state.createCalls++;
			return gate.promise;
		};
		const first = flow.createLink({ level: 'write' });
		const second = await flow.createLink({ level: 'read' }); // double-click
		expect(second).toBeNull();
		gate.resolve(link('l1'));
		const created = await first;
		expect(created?.id).toBe('l1');
		expect(state.createCalls).toBe(1);
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']);
	});

	it('revoke is conservative: the link leaves the panel only once the engine confirmed', async () => {
		const { engine } = fakeEngine({ links: [link('l1')] });
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		const gate = deferred<void>();
		engine.revokeLink = () => gate.promise;
		const done = flow.revokeLink('l1');
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']); // still there
		gate.resolve();
		expect(await done).toBe(true);
		expect(flow.snapshot.links).toEqual([]);
	});

	it('a failed revoke keeps the link and reports, instead of lying', async () => {
		const { engine } = fakeEngine({ links: [link('l1')] });
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		engine.revokeLink = async () => {
			throw new Error('relay down');
		};
		expect(await flow.revokeLink('l1')).toBe(false);
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']);
		expect(flow.snapshot.error?.code).toBe('TARGET_UNAVAILABLE');
	});

	it('removing a member works, removing yourself is refused up front', async () => {
		const { engine, state } = fakeEngine({
			members: [member('me', true), member('them')]
		});
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		expect(await flow.removeMember('them')).toBe(true);
		expect(flow.snapshot.members.map((m) => m.id)).toEqual(['me']);

		await expect(flow.removeMember('me')).rejects.toThrow(TypeError);
		expect(state.removeCalls).toBe(1); // the engine never saw the self-removal
	});

	it('an engine without member management says so', async () => {
		const engine: ShareEngine = {
			async list() {
				return { links: [], members: [] };
			},
			async createLink(opts) {
				return { ...link('l1'), ...opts };
			},
			async revokeLink() {
				/* nothing */
			}
		};
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);
		expect(flow.snapshot.canRemoveMembers).toBe(false);
		await expect(flow.removeMember('them')).rejects.toThrow(TypeError);
	});
});

describe('shareFlow: ending the share', () => {
	it('an engine without revokeAll hides the action and says so', async () => {
		const { engine } = fakeEngine(); // fakeEngine ships no revokeAll
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);
		expect(flow.snapshot.canRevokeAll).toBe(false);
		await expect(flow.revokeAll()).rejects.toThrow(TypeError);
	});

	it('revokeAll is conservative: the panel empties only once the engine confirmed', async () => {
		const { engine } = fakeEngine({
			links: [link('l1')],
			members: [member('me', true), member('them')]
		});
		const gate = deferred<void>();
		engine.revokeAll = () => gate.promise;
		const flow = shareFlow(engine);
		const s = await until(flow, (x) => x.busy === null);
		expect(s.canRevokeAll).toBe(true);

		const done = flow.revokeAll();
		expect(flow.snapshot.busy).toBe('revoke-all');
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']); // still there
		gate.resolve();
		expect(await done).toBe(true);
		expect(flow.snapshot.links).toEqual([]);
		expect(flow.snapshot.members).toEqual([]);
		expect(flow.snapshot.error).toBeNull();
	});

	it('a failed revokeAll keeps every list and reports, instead of lying', async () => {
		const { engine } = fakeEngine({ links: [link('l1')], members: [member('me', true)] });
		engine.revokeAll = async () => {
			throw new Error('relay down');
		};
		const flow = shareFlow(engine);
		await until(flow, (x) => x.busy === null);

		expect(await flow.revokeAll()).toBe(false);
		expect(flow.snapshot.links.map((l) => l.id)).toEqual(['l1']);
		expect(flow.snapshot.members.map((m) => m.id)).toEqual(['me']);
		expect(flow.snapshot.error?.code).toBe('TARGET_UNAVAILABLE');
	});
});
