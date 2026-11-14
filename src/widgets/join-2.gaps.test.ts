// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SelfstoreJoinElement } from './join';
import type { JoinEngine } from '../flows/join';

function defineSelfstoreWidgets() {
	if (!customElements.get('selfstore-join')) {
		customElements.define('selfstore-join', SelfstoreJoinElement);
	}
}

function fakeEngine(): JoinEngine {
	return {
		async preview() {
			return { label: 'Test', from: 'a@b.c', level: 'read' as const };
		},
		async join() {
			return 'joined';
		}
	};
}

describe('SelfstoreJoinElement.flow getter', () => {
	beforeAll(() => {
		defineSelfstoreWidgets();
	});

	it('returns null before wire() runs', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		expect(el.flow).toBeNull();
	});

	it('returns the JoinFlow instance after wiring', async () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		document.body.append(el);
		el.engine = fakeEngine();
		el.link = 'https://x.test/join#k=abc';
		await vi.waitFor(() => expect(el.flow).not.toBeNull());
		const flow = el.flow!;
		expect(flow).toBeDefined();
		expect(typeof flow.subscribe).toBe('function');
		expect(typeof flow.accept).toBe('function');
	});

	it('returns the same instance on repeated access', async () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		document.body.append(el);
		el.engine = fakeEngine();
		el.link = 'https://x.test/join#k=abc';
		await vi.waitFor(() => expect(el.flow).not.toBeNull());
		const first = el.flow;
		const second = el.flow;
		expect(first).toBe(second);
	});

	it('hands its options to the flow it creates', async () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		document.body.append(el);
		// A preview that never settles: the step cannot move on its own, so the
		// only way out of 'previewing' is the deadline the element was given.
		el.engine = {
			preview: () => new Promise<never>(() => undefined),
			join: () => Promise.resolve('joined')
		};
		el.link = 'https://x.test/join#k=abc';
		el.options = { deadlineMs: 20 };
		await vi.waitFor(() => expect(el.flow).not.toBeNull());
		expect(el.flow!.snapshot.step).toBe('previewing');
		await vi.waitFor(() => expect(el.flow!.snapshot.step).toBe('error'), { timeout: 2000 });
	});
});
