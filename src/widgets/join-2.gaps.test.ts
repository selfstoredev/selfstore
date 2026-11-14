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

	it('reflects the flow created by joinFlow with given options', async () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		document.body.append(el);
		el.engine = fakeEngine();
		el.link = 'https://x.test/join#k=abc';
		el.options = { deadlineMs: 1234 };
		await vi.waitFor(() => expect(el.flow).not.toBeNull());
		const snap = el.flow!.snapshot;
		expect(snap.step).toBe('previewing');
	});
});
