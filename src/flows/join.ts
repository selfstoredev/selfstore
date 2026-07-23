// joinFlow: opening an invitation link, as a headless machine over an
// injected JoinEngine. Preview first, join on an explicit yes. The flow
// holds the link itself, so a re-render, a login roundtrip or an account
// switch cannot lose the invitation out from under the user. Joining is
// single-flight. Mismatch ("this device already follows another share") and
// no-invite ("spent, or not for this account") are outcomes with their own
// steps, not generic errors - each has a different way out. Switching
// accounts re-previews under the new account. A cancelled or superseded leg
// cannot resurrect the flow, and every network leg runs under a deadline.

import type { StoreError } from '../persistence/store';
import { makeMachine, toStoreError, withDeadline, type FlowStore } from './machine';
import type { ShareLevel } from './share';

/** What the user is about to join - enough to render an honest question. */
export interface JoinPreview {
	/** The share's display name, when the link carries one. */
	label?: string;
	/** Who shared it (a name, an email - whatever the engine knows). */
	from?: string;
	level?: ShareLevel;
}

/** How joining ended, other than plain failure:
 *  'joined'    - this device now follows the share.
 *  'mismatch'  - this device already follows a DIFFERENT share: joining a
 *                second one is refused (leave the first, or use another
 *                device/profile).
 *  'no-invite' - the invitation is spent, expired, or aimed at another
 *                account (switching accounts may be the fix). */
export type JoinOutcome = 'joined' | 'mismatch' | 'no-invite';

/** The app-side port: how a link is read and honoured on this transport. */
export interface JoinEngine {
	/** Read-only look at the invitation. Must change NOTHING. */
	preview(link: string): Promise<JoinPreview>;
	/** Consume the invitation and wire the share. Resolve null when the user
	 *  backed out of a popup the engine had to open (an account chooser, a
	 *  consent screen): the flow returns to 'ready' silently - backing out of
	 *  a human gesture is not an error, here as everywhere in these flows. */
	join(link: string): Promise<JoinOutcome | null>;
	/** Optional: re-run the account chooser (the invite may belong to another
	 *  account). The flow re-previews after it. */
	switchAccount?(): Promise<void>;
}

export type JoinStep =
	| 'previewing'
	| 'ready'
	| 'joining'
	| 'joined'
	| 'mismatch'
	| 'no-invite'
	| 'error';

export interface JoinSnapshot {
	/** The invitation this flow was opened with - held here so the UI can
	 *  always find it again. */
	link: string;
	step: JoinStep;
	/** Set once previewed (kept through errors, so retry re-renders context). */
	preview: JoinPreview | null;
	/** The engine offers an account switch. */
	canSwitchAccount: boolean;
	busy: boolean;
	/** Set when step === 'error': show `labelKey`, log `message`. */
	error: StoreError | null;
}

export interface JoinFlow extends FlowStore<JoinSnapshot> {
	/** Say yes: consume the invitation. Only from 'ready'. */
	accept(): void;
	/** Re-run the account chooser, then preview again under the new account.
	 *  Available from 'ready', 'no-invite' and 'error' when the engine offers it. */
	switchAccount(): void;
	/** From 'error': preview again and resume the journey. */
	retry(): void;
}

const DEFAULT_DEADLINE_MS = 30_000;

export function joinFlow(
	link: string,
	engine: JoinEngine,
	options: { deadlineMs?: number } = {}
): JoinFlow {
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

	const m = makeMachine<JoinSnapshot>({
		link,
		step: 'previewing',
		preview: null,
		canSwitchAccount: typeof engine.switchAccount === 'function',
		busy: true,
		error: null
	});

	let generation = 0;

	function preview(): void {
		const gen = ++generation;
		m.set({ step: 'previewing', busy: true, error: null });
		void withDeadline(engine.preview(link), deadlineMs, 'The invitation')
			.then((p) => {
				if (gen !== generation) return;
				m.set({ step: 'ready', preview: p, busy: false });
			})
			.catch((e) => {
				if (gen !== generation) return;
				m.set({ step: 'error', busy: false, error: toStoreError(e) });
			});
	}

	preview();

	return {
		get snapshot() {
			return m.snapshot;
		},
		subscribe: m.subscribe,

		accept(): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'ready') return; // single-flight: one join per yes
			const gen = ++generation;
			m.set({ step: 'joining', busy: true, error: null });
			void withDeadline(engine.join(link), deadlineMs, 'Joining')
				.then((outcome) => {
					if (gen !== generation) return;
					if (outcome === null) {
						// The user backed out of the engine's popup: the question is
						// still live, the preview still good - just ask again.
						m.set({ step: 'ready', busy: false });
						return;
					}
					m.set({ step: outcome, busy: false });
				})
				.catch((e) => {
					if (gen !== generation) return;
					m.set({ step: 'error', busy: false, error: toStoreError(e) });
				});
		},

		switchAccount(): void {
			const switcher = engine.switchAccount?.bind(engine);
			if (!switcher) return;
			const { step, busy } = m.snapshot;
			if (busy || (step !== 'ready' && step !== 'no-invite' && step !== 'error')) return;
			const gen = ++generation;
			m.set({ busy: true, error: null });
			void switcher()
				.then(() => {
					if (gen !== generation) return;
					preview(); // the other account may hold the right invite: look again
				})
				.catch((e) => {
					if (gen !== generation) return;
					m.set({ step: 'error', busy: false, error: toStoreError(e) });
				});
		},

		retry(): void {
			if (m.snapshot.step !== 'error') return;
			preview();
		}
	};
}
