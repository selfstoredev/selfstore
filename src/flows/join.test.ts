/**
 * joinFlow: opening an invitation. Preview before commit, outcomes with their
 * own names, the link never lost, the account switch part of the journey.
 */

import { describe, it, expect } from 'vitest';
import { joinFlow, type JoinEngine, type JoinOutcome } from './join';
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

const LINK = 'https://x.test/join#k=abc';

function fakeEngine(joinOutcome: JoinOutcome = 'joined') {
	const state = { previews: 0, joins: 0 };
	const engine: JoinEngine = {
		async preview() {
			state.previews++;
			return { label: 'Family wallet', from: 'ada@example.test', level: 'write' as const };
		},
		async join() {
			state.joins++;
			return joinOutcome;
		}
	};
	return { engine, state };
}

describe('joinFlow: preview before commit', () => {
	it('previews the invitation and waits for an explicit yes', async () => {
		const { engine, state } = fakeEngine();
		const flow = joinFlow(LINK, engine);
		const s = await until(flow, (x) => x.step === 'ready');
		expect(s.preview?.label).toBe('Family wallet');
		expect(s.preview?.from).toBe('ada@example.test');
		expect(state.joins).toBe(0); // nothing joined without the yes
	});

	it('holds the link for the whole journey - a re-render can never lose it', async () => {
		const { engine } = fakeEngine();
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		expect(flow.snapshot.link).toBe(LINK);
	});

	it('a preview failure is retryable, and retry previews again', async () => {
		const { engine, state } = fakeEngine();
		engine.preview = async () => {
			throw new Error('relay down');
		};
		const flow = joinFlow(LINK, engine);
		const s = await until(flow, (x) => x.step === 'error');
		expect(s.error?.code).toBe('TARGET_UNAVAILABLE');
		expect(s.link).toBe(LINK);

		engine.preview = async () => {
			state.previews++;
			return { label: 'Family wallet' };
		};
		flow.retry();
		await until(flow, (x) => x.step === 'ready');
	});
});

describe('joinFlow: joining', () => {
	it('accept joins exactly once - a double yes is one join', async () => {
		const { engine, state } = fakeEngine();
		const gate = deferred<JoinOutcome>();
		engine.join = () => {
			state.joins++;
			return gate.promise;
		};
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		flow.accept(); // double-click
		gate.resolve('joined');
		const s = await until(flow, (x) => x.step === 'joined');
		expect(state.joins).toBe(1);
		expect(s.error).toBeNull();
	});

	it('"already following another share" is an outcome with its own name, not an error', async () => {
		const { engine } = fakeEngine('mismatch');
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		const s = await until(flow, (x) => x.step === 'mismatch');
		expect(s.error).toBeNull();
	});

	it('"invite spent or aimed at another account" is the no-invite outcome', async () => {
		const { engine } = fakeEngine('no-invite');
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		const s = await until(flow, (x) => x.step === 'no-invite');
		expect(s.error).toBeNull();
	});

	it('a join that never answers becomes a retryable error under the deadline', async () => {
		const { engine } = fakeEngine();
		engine.join = () => new Promise(() => undefined);
		const flow = joinFlow(LINK, engine, { deadlineMs: 30 });
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		const s = await until(flow, (x) => x.step === 'error');
		expect(s.error?.code).toBe('TARGET_UNAVAILABLE');
		expect(s.preview?.label).toBe('Family wallet'); // context kept for the retry
	});
});

describe('joinFlow: switching accounts', () => {
	it('re-previews under the new account (the right invite may live there)', async () => {
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
		const flow = joinFlow(LINK, engine);
		const s1 = await until(flow, (x) => x.step === 'ready');
		expect(s1.canSwitchAccount).toBe(true);
		expect(s1.preview?.label).toBe('wallet of first');

		flow.switchAccount();
		const s2 = await until(flow, (x) => x.step === 'ready' && x.preview?.label === 'wallet of second');
		expect(s2.error).toBeNull();
	});

	it('from no-invite, switching accounts is the way out', async () => {
		let account = 'wrong';
		const engine: JoinEngine = {
			async preview() {
				return { label: 'Family wallet' };
			},
			async join() {
				return account === 'right' ? 'joined' : 'no-invite';
			},
			async switchAccount() {
				account = 'right';
			}
		};
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		await until(flow, (x) => x.step === 'no-invite');

		flow.switchAccount();
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		await until(flow, (x) => x.step === 'joined');
	});

	it('without an account switcher the affordance is simply absent', async () => {
		const { engine } = fakeEngine();
		const flow = joinFlow(LINK, engine);
		const s = await until(flow, (x) => x.step === 'ready');
		expect(s.canSwitchAccount).toBe(false);
		flow.switchAccount(); // no-op, no crash
		expect(flow.snapshot.step).toBe('ready');
	});

	it('an engine answering null (the user backed out of its popup) returns to ready, silently', async () => {
		let joins = 0;
		const engine: JoinEngine = {
			async preview() {
				return { label: 'Family wallet' };
			},
			async join() {
				joins++;
				return joins === 1 ? null : 'joined';
			}
		};
		const flow = joinFlow(LINK, engine);
		await until(flow, (x) => x.step === 'ready');
		flow.accept();
		const s = await until(flow, (x) => x.step === 'ready' && !x.busy && joins === 1);
		expect(s.error).toBeNull(); // backing out is not an error
		expect(s.preview?.label).toBe('Family wallet'); // the question is still live
		flow.accept(); // saying yes again just works
		await until(flow, (x) => x.step === 'joined');
	});
});
