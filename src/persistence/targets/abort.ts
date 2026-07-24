/**
 * Deadline + life-signal composition for target requests. Every target fetch
 * carries a per-request deadline; composing it with the target's LIFE signal
 * lets abortInFlight() (the user detaching the destination) cut a suspended
 * request NOW instead of letting the detach wait behind the deadline. The
 * composition is done by hand (not AbortSignal.any) so behaviour is identical
 * on every engine the library supports.
 */

import { SelfstoreError } from '../../selfstore';

export function boundedSignal(deadlineMs: number, life?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(deadlineMs);
	if (!life) return deadline;
	if (life.aborted) return life;
	const ctl = new AbortController();
	deadline.addEventListener('abort', () => ctl.abort(deadline.reason), { once: true });
	life.addEventListener('abort', () => ctl.abort(life.reason), { once: true });
	return ctl.signal;
}

/** A target's resettable LIFE line. cut() aborts everything bound to the
 *  CURRENT signal (with the standard transient detach reason) and re-arms,
 *  so work started after the cut lives normally. cut is `this`-free: targets
 *  expose it directly as their abortInFlight. */
export function lifeLine(): { current(): AbortSignal; cut(): void } {
	let ctl = new AbortController();
	return {
		current: () => ctl.signal,
		cut(): void {
			const c = ctl;
			ctl = new AbortController();
			c.abort(new SelfstoreError('TARGET_UNAVAILABLE', 'Request aborted: target detaching.'));
		}
	};
}
