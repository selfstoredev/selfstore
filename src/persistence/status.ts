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
		return {
			state: 'pending-download',
			severity: 'info',
			actionable: true,
			action: 'download',
			labelKey: 'status.pendingDownload'
		};
	}

	if (input.targetKind === 'device') {
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
