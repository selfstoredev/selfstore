// abort.ts composes a per-request deadline with a target's resettable LIFE
// line by hand (not AbortSignal.any) so a detach can cut a suspended request
// before its deadline. These tests pin that composition: which reason wins,
// that an already-dead life short-circuits, and that cut() re-arms so work
// started after a detach lives normally.

import { describe, it, expect } from 'vitest';
import { boundedSignal, lifeLine } from './abort';
import { isSelfstoreError } from '../../selfstore';

/** Resolve once the signal aborts (or immediately if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) =>
		signal.addEventListener('abort', () => resolve(), { once: true })
	);
}

describe('boundedSignal', () => {
	it('without a life signal, aborts once the short deadline elapses', async () => {
		const s = boundedSignal(5);
		expect(s.aborted).toBe(false);
		await aborted(s);
		expect(s.aborted).toBe(true);
	});

	it('returns the life signal itself when it is already aborted', () => {
		const ctl = new AbortController();
		const reason = new Error('already gone');
		ctl.abort(reason);
		const s = boundedSignal(1000, ctl.signal);
		expect(s).toBe(ctl.signal);
		expect(s.aborted).toBe(true);
		expect(s.reason).toBe(reason);
	});

	it('with both live, is not aborted up front', () => {
		const life = new AbortController();
		const s = boundedSignal(1000, life.signal);
		expect(s).not.toBe(life.signal);
		expect(s.aborted).toBe(false);
	});

	it('aborts with the deadline reason when the deadline wins', async () => {
		const life = new AbortController();
		const s = boundedSignal(5, life.signal);
		await aborted(s);
		expect(s.aborted).toBe(true);
		expect(life.signal.aborted).toBe(false);
	});

	it('aborts with the life reason when the life line wins', async () => {
		const life = new AbortController();
		const s = boundedSignal(60_000, life.signal);
		const reason = new Error('detached first');
		life.abort(reason);
		await aborted(s);
		expect(s.reason).toBe(reason);
	});
});

describe('lifeLine', () => {
	it('starts armed: current() is a live signal', () => {
		const life = lifeLine();
		expect(life.current().aborted).toBe(false);
	});

	it('cut() aborts the current signal with a transient TARGET_UNAVAILABLE reason', () => {
		const life = lifeLine();
		const before = life.current();
		life.cut();
		expect(before.aborted).toBe(true);
		expect(isSelfstoreError(before.reason) && before.reason.code === 'TARGET_UNAVAILABLE').toBe(
			true
		);
	});

	it('re-arms after a cut: work started later gets a fresh, live signal', () => {
		const life = lifeLine();
		const before = life.current();
		life.cut();
		const after = life.current();
		expect(after).not.toBe(before);
		expect(after.aborted).toBe(false);
	});

	it('cuts only signals bound before it, leaving later work untouched', async () => {
		const life = lifeLine();
		const inflight = boundedSignal(60_000, life.current());
		life.cut();
		await aborted(inflight);
		expect(inflight.aborted).toBe(true);

		const next = boundedSignal(60_000, life.current());
		expect(next.aborted).toBe(false);
	});
});
