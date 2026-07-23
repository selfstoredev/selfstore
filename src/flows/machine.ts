// Shared plumbing for the flows: a tiny observable snapshot (fits the
// Svelte store contract and React's useSyncExternalStore), a deadline
// wrapper for network legs, and the normalizer that turns anything thrown
// into the stable { code, labelKey, message } shape.

import type { StoreError } from '../persistence/store';
import { SelfstoreError, errorLabelKey, isSelfstoreError } from '../selfstore/errors';

/** What every flow exposes: the current snapshot plus a subscription.
 *  `subscribe` calls the listener IMMEDIATELY with the current snapshot and on
 *  every change after - that is the Svelte store contract, so a flow works as
 *  `$flow` in Svelte; React reads `useSyncExternalStore(flow.subscribe, () =>
 *  flow.snapshot)`; everyone else just re-renders in the callback. */
export interface FlowStore<T> {
	readonly snapshot: T;
	subscribe(listener: (snapshot: T) => void): () => void;
}

export interface Machine<T> extends FlowStore<T> {
	/** Merge a partial into the snapshot and notify. */
	set(patch: Partial<T>): void;
}

export function makeMachine<T extends object>(initial: T): Machine<T> {
	let snapshot = initial;
	const listeners = new Set<(s: T) => void>();
	return {
		get snapshot(): T {
			return snapshot;
		},
		set(patch: Partial<T>): void {
			snapshot = { ...snapshot, ...patch };
			listeners.forEach((fn) => fn(snapshot));
		},
		subscribe(listener: (s: T) => void): () => void {
			listeners.add(listener);
			listener(snapshot);
			return () => listeners.delete(listener);
		}
	};
}

/** Bound a network leg so a stuck destination surfaces as a retryable error
 *  instead of a flow frozen on a spinner. The rejection is TARGET_UNAVAILABLE -
 *  transient by contract - because "did not answer in time" says nothing about
 *  access being lost. Never wrap a human step (a consent popup, a picker):
 *  people are allowed to be slower than a deadline. */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gate = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(new SelfstoreError('TARGET_UNAVAILABLE', `${what} did not answer within ${ms}ms.`)),
			ms
		);
	});
	try {
		return await Promise.race([work, gate]);
	} finally {
		clearTimeout(timer);
	}
}

/** Normalize anything thrown into the stable StoreError shape the whole
 *  library reports with: show `labelKey`, log `message`. Unknown errors map to
 *  TARGET_UNAVAILABLE (transient, retryable) - the flow never invents new
 *  codes for the app to branch on. */
export function toStoreError(e: unknown): StoreError {
	if (isSelfstoreError(e)) {
		return { code: e.code, labelKey: errorLabelKey(e.code), message: e.message };
	}
	const message = e instanceof Error ? e.message : String(e);
	return { code: 'TARGET_UNAVAILABLE', labelKey: errorLabelKey('TARGET_UNAVAILABLE'), message };
}
