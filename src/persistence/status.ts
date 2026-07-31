// Headless status derivation: raw store flags in, semantic descriptor out
// (state, severity, action, labelKey). No colours, no copy - the app owns both.

export type Severity = 'ok' | 'info' | 'warn' | 'danger';

export type StorageState =
	'ephemeral' | 'cache-only' | 'saving' | 'saved' | 'pending-download' | 'needs-attention';

/** A suggested action the UI can wire to a button. */
export type StatusAction = 'choose-destination' | 'download' | 'reconnect' | 'unlock';

/** The headless descriptor the UI renders. */
export interface StatusDescriptor {
	state: StorageState;
	severity: Severity;
	actionable: boolean;
	action?: StatusAction;
	/** Stable i18n key; the app owns the actual copy. */
	labelKey: string;
}

export interface StatusInput {
	/** False means ephemeral (the local cache is off). */
	persistent: boolean;
	/** Any BackupTarget kind, or a reserved store mode ('device', 'file-manual'). */
	targetKind: string;
	saving: boolean;
	/** The durable home needs a user gesture (token expired, permission lapsed, locked). */
	needsAttention: boolean;
	/** The attention is a lock (password not in memory): the gesture is unlock, not reconnect. */
	locked: boolean;
	/** Degraded file mode has changes awaiting a manual download. */
	pendingDownload: boolean;
	/** A portable copy was written at some point, and whether anything has been
	 *  entered since. Without a durable destination, this is the difference
	 *  between "never saved anywhere" and "saved this morning". */
	copy?: { at: number | null; stale: boolean };
}

import { isReservedStoreMode } from './target';

/** A kind that names a real durable target (anything but the store modes). */
const isDurableKind = (kind: string): boolean => !isReservedStoreMode(kind);

/** Map the store's raw flags to a single, ranked status; the most important wins. */
export function deriveStatus(input: StatusInput): StatusDescriptor {
	if (!input.persistent) {
		return {
			state: 'ephemeral',
			severity: 'warn',
			actionable: true,
			action: 'choose-destination',
			labelKey: 'status.ephemeral'
		};
	}

	if (isDurableKind(input.targetKind) && input.needsAttention) {
		return {
			state: 'needs-attention',
			severity: 'danger',
			actionable: true,
			action: input.locked ? 'unlock' : 'reconnect',
			labelKey: input.locked ? 'status.locked' : 'status.needsAttention'
		};
	}

	if (input.saving) {
		return { state: 'saving', severity: 'info', actionable: false, labelKey: 'status.saving' };
	}

	if (input.targetKind === 'file-manual' && input.pendingDownload) {
		// A warning, not information: what has been typed since the last export
		// exists nowhere but this browser. 'info' rendered as a calm pill next to a
		// button asking for a gesture - the colour said everything was fine while
		// the button said otherwise.
		return {
			state: 'pending-download',
			severity: 'warn',
			actionable: true,
			action: 'download',
			labelKey: 'status.pendingDownload'
		};
	}

	if (input.targetKind === 'device') {
		// A copy the user wrote is not nothing. Announcing "never saved anywhere"
		// to someone looking at the backup they exported an hour ago is the kind
		// of sentence that costs the app its credibility - and every consumer that
		// hit it kept its own memo to work around it. The state stays cache-only
		// (no durable destination is attached, and that IS what the gesture is
		// for); only the sentence, and the alarm, follow the facts.
		if (input.copy?.at) {
			return {
				state: 'cache-only',
				severity: input.copy.stale ? 'warn' : 'ok',
				actionable: true,
				action: 'choose-destination',
				labelKey: input.copy.stale ? 'status.copyStale' : 'status.copy'
			};
		}
		return {
			state: 'cache-only',
			severity: 'warn',
			actionable: true,
			action: 'choose-destination',
			labelKey: 'status.cacheOnly'
		};
	}

	return { state: 'saved', severity: 'ok', actionable: false, labelKey: 'status.saved' };
}
