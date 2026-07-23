// connectFlow: the "where does my data live" journey as a headless state
// machine. It owns ordering and failure rules that took a series of
// production hotfixes to get right, each covered by a test:
//
//   choose -> (form) -> authorizing -> (password) -> (conflict) -> connected
//                                                              \-> error
//
// One popup per gesture (re-entry ignored while a leg is in flight), and a
// cancelled popup is not an error - back to 'choose', silently. An encrypted
// backup's password is proven by a trial read while the store is untouched,
// so a wrong password can never half-connect (deferUnlock opts out: adopt
// locked, unlock where the host chooses). overwrite() is the forgotten-
// password escape: local wiped first, tiny blank write. Merge is the default
// reconciliation; the destructive choices hide behind 'conflict', which only
// appears when the app declared local data worth asking about. Network legs
// run under a deadline; human steps never do. A cancelled journey stays
// dead - late resolutions are discarded (generation counter).

import type { LocalStore, StoreError } from '../persistence/store';
import type { BackupTarget } from '../persistence/target';
import type { KV } from '../persistence/cache';
import { restore } from '../selfstore/fluent';
import { SelfstoreError, isSelfstoreError } from '../selfstore/errors';
import { connect as driveConnect, type DriveAuth } from '../persistence/targets/drive';
import {
	connect as fileConnect,
	isSupported as fileIsSupported,
	openExisting as fileOpenExisting
} from '../persistence/targets/file';
import { connect as webdavConnect, type WebdavConfig } from '../persistence/targets/webdav';
import { connect as s3Connect, type S3Config } from '../persistence/targets/s3';
import { makeMachine, toStoreError, withDeadline, type FlowStore } from './machine';

export type ConnectKind = 'drive' | 'file' | 'webdav' | 's3';

/** Produce a connected BackupTarget, or null when the user cancelled the
 *  gesture (consent refused, picker closed). Custom connectors slot custom
 *  targets - or test fakes - into the same journey. */
export type Connector = () => Promise<BackupTarget | null>;

/** Which destinations the flow offers, and how to open each one. The offer
 *  renders in this OBJECT's insertion order: the host decides which
 *  destination leads by how it writes the object, not by a ranking here. */
export interface ConnectTargets {
	/** Google Drive: the auth strategy (e.g. gisDriveAuth), or a custom connector. */
	drive?: DriveAuth | Connector;
	/** Local file via the browser's picker (true), or a custom connector. On
	 *  browsers without the File System Access API the flow degrades to the
	 *  manual download mode by itself. The object form offers TWO gestures on
	 *  the same destination: `create` (save picker: start or overwrite a backup
	 *  file) and `open` (open picker: adopt an EXISTING backup file - it then
	 *  goes through the same inspect/password/resolution journey). */
	file?: true | Connector | { create?: true | Connector; open?: true | Connector };
	/** WebDAV: true renders a 'form' step and expects submitWebdav(config);
	 *  a fixed WebdavConfig skips the form; or a custom connector. */
	webdav?: true | WebdavConfig | Connector;
	/** S3-compatible bucket (Amazon S3, R2, B2, MinIO): true renders a 'form'
	 *  step and expects submitS3(config); a fixed S3Config skips the form; or a
	 *  custom connector. Offer it alongside `webdav` and the widget groups both
	 *  under one "your server" entry with a WebDAV/S3 toggle. */
	s3?: true | S3Config | Connector;
}

/** What the flows need from the store. The simple store exposes this as
 *  `store.flowHost`; an advanced-store app builds it by hand. */
export interface FlowHost {
	engine: LocalStore;
	kv: KV;
	/** Backup file name on the destination (the simple store uses `app.zip`). */
	backupName: string;
}

export interface ConnectFlowOptions {
	/** Declare when this device holds data worth a question: only then does an
	 *  existing backup raise the 'conflict' step with the destructive choices.
	 *  Default: never - the flow applies defaultResolution. */
	hasLocalData?: () => boolean;
	/** How to reconcile with a destination that already holds a backup when the
	 *  conflict step is not raised. Default 'merge' - the only choice that
	 *  loses nothing on either side. 'resume' adopts the backup (the
	 *  destination wins; this device's working copy is replaced), 'replace'
	 *  overwrites the backup with this device. An encrypted backup still asks
	 *  for its password first, whatever the resolution; an empty destination
	 *  is not concerned (this device's data simply becomes its content). */
	defaultResolution?: ConnectResolution;
	/** Skip the password step on an encrypted backup: adopt it AS is (resume)
	 *  and complete with the store locked - nothing readable, nothing
	 *  clobbered - for the host to unlock on its own surface (engine.unlock)
	 *  after the connect. Adoption is forced whatever defaultResolution says:
	 *  without the proven key a merge is impossible and a replace would
	 *  destroy a backup no one proved they own. Hosts that let a device
	 *  holding real local data connect should keep the password-first
	 *  journey - adoption replaces the working copy. */
	deferUnlock?: boolean;
	/** Deadline for each network leg (inspect, trial-read, attach), ms. */
	deadlineMs?: number;
}

export type ConnectStep =
	'choose' | 'form' | 'authorizing' | 'password' | 'conflict' | 'connected' | 'error';

/** How to reconcile with a destination that already holds a backup. */
export type ConnectResolution = 'merge' | 'resume' | 'replace';

/** What connecting did. 'merged': both sides folded. 'started': empty
 *  destination now holds this device's data. 'resumed': the backup won,
 *  this device adopted it. 'replaced': this device won, the backup was
 *  overwritten. 'manual': degraded download-on-demand file mode. */
export type ConnectFlowOutcome = 'merged' | 'started' | 'resumed' | 'replaced' | 'manual';

export interface ConnectSnapshot {
	step: ConnectStep;
	/** The destinations to offer, in the order given. */
	kinds: readonly ConnectKind[];
	/** The destination being connected (null while choosing). */
	kind: ConnectKind | null;
	/** Set when step === 'connected'. */
	outcome: ConnectFlowOutcome | null;
	/** Known after inspection: the destination already holds a backup. */
	hasBackup: boolean;
	/** ...and that backup is encrypted. */
	encrypted: boolean;
	/** The last submitPassword() was wrong (stay on 'password', say so). */
	passwordError: boolean;
	/** An async leg is in flight (render a spinner, disable the actions). */
	busy: boolean;
	/** Set when step === 'error': show `labelKey`, log `message`. */
	error: StoreError | null;
}

export interface ConnectFlow extends FlowStore<ConnectSnapshot> {
	/** Pick a destination. Call it inside the user's click: the consent popup /
	 *  file picker opens synchronously from the gesture. Ignored while a leg is
	 *  already in flight (one popup per gesture). For a `file` target declared
	 *  with the object form, `variant` picks the gesture: 'create' (default,
	 *  save picker) or 'open' (adopt an existing backup file). */
	choose(kind: ConnectKind, variant?: 'create' | 'open'): void;
	/** 'form' step (webdav: true): submit the server config. */
	submitWebdav(config: WebdavConfig): void;
	/** 'form' step (s3: true): submit the bucket config. */
	submitS3(config: S3Config): void;
	/** 'password' step: prove the backup's password. Wrong password sets
	 *  passwordError and stays here; nothing is attached either way. */
	submitPassword(password: string): void;
	/** 'password' step escape hatch: give up on a forgotten password and start a
	 *  fresh backup over the protected one. The encrypted backup is overwritten
	 *  by this device's data (possibly empty) and lost for good - the only way
	 *  out when the password cannot be recovered. */
	overwrite(): void;
	/** 'conflict' step: pick the reconciliation. */
	resolveConflict(how: ConnectResolution): void;
	/** Abandon the journey in progress: back to 'choose'. A late resolution of
	 *  the abandoned leg is discarded. */
	cancel(): void;
	/** 'error' step: back to 'choose' to try again. */
	retry(): void;
}

const DEFAULT_DEADLINE_MS = 30_000;

/** A resolution's attach plan: which strategy runs, which outcome it names. */
function planFor(how: ConnectResolution): {
	strategy: 'merge' | 'replace-local' | 'replace-remote';
	outcome: ConnectFlowOutcome;
} {
	if (how === 'resume') return { strategy: 'replace-local', outcome: 'resumed' };
	if (how === 'replace') return { strategy: 'replace-remote', outcome: 'replaced' };
	return { strategy: 'merge', outcome: 'merged' };
}

export function connectFlow(
	store: FlowHost | { flowHost: FlowHost },
	targets: ConnectTargets,
	options: ConnectFlowOptions = {}
): ConnectFlow {
	const host = 'flowHost' in store ? store.flowHost : store;
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const kinds = (Object.keys(targets) as ConnectKind[]).filter(
		(k) => (k === 'drive' || k === 'file' || k === 'webdav' || k === 's3') && targets[k] != null
	);

	const m = makeMachine<ConnectSnapshot>({
		step: 'choose',
		kinds,
		kind: null,
		outcome: null,
		hasBackup: false,
		encrypted: false,
		passwordError: false,
		busy: false,
		error: null
	});

	// The journey's working set. `generation` invalidates in-flight legs on
	// cancel(): whoever resolves late compares its captured generation and
	// drops its result instead of resurrecting an abandoned journey.
	let generation = 0;
	let target: BackupTarget | null = null;
	let password: string | null = null;

	const backToChoose = (): void => {
		generation++;
		target = null;
		password = null;
		m.set({
			step: 'choose',
			kind: null,
			outcome: null,
			hasBackup: false,
			encrypted: false,
			passwordError: false,
			busy: false,
			error: null
		});
	};

	const fail = (e: unknown): void => {
		password = null;
		m.set({ step: 'error', busy: false, error: toStoreError(e) });
	};

	function connectorFor(
		kind: ConnectKind,
		variant: 'create' | 'open' = 'create'
	): Connector | null {
		const spec = targets[kind];
		if (spec == null) return null;
		if (typeof spec === 'function') return spec;
		if (kind === 'drive') {
			const auth = spec as DriveAuth;
			return () => driveConnect({ auth, kv: host.kv, fileName: host.backupName });
		}
		if (kind === 'file') {
			// Object form: each gesture has its own spec ('open' has no built-in
			// meaning for other kinds, so it resolves here only).
			if (typeof spec === 'object' && !('url' in spec)) {
				const sub = (spec as { create?: true | Connector; open?: true | Connector })[variant];
				if (sub == null) return null;
				if (typeof sub === 'function') return sub;
				return variant === 'open'
					? () => fileOpenExisting({ kv: host.kv })
					: () => fileConnect({ kv: host.kv, fileName: host.backupName });
			}
			return () => fileConnect({ kv: host.kv, fileName: host.backupName });
		}
		if (kind === 's3') {
			const config = spec as S3Config; // 's3: true' goes through the form step
			return () => s3Connect({ kv: host.kv, config });
		}
		const config = spec as WebdavConfig; // 'webdav: true' goes through the form step
		return () => webdavConnect({ kv: host.kv, config });
	}

	/** After the target is in hand: inspect, then route to password / conflict /
	 *  attach. Everything here is network - deadline-bounded, generation-checked. */
	async function inspectAndRoute(gen: number, t: BackupTarget): Promise<void> {
		const info = await withDeadline(host.engine.inspectTarget(t), deadlineMs, 'The destination');
		if (gen !== generation) return;
		target = t;
		m.set({ hasBackup: info.hasBackup, encrypted: info.encrypted });
		if (!info.hasBackup) {
			// Empty destination: this device's data becomes its content. Nothing
			// to ask, nothing to lose.
			await attach(gen, 'replace-remote', 'started');
			return;
		}
		if (info.encrypted) {
			if (options.deferUnlock) {
				// The host owns the unlock surface: adopt the backup as it stands.
				// A null password on an encrypted file lands the store locked -
				// nothing readable, nothing clobbered - until engine.unlock()
				// proves the password wherever the host asks for it. The conflict
				// step is moot here: without the key, merge cannot read the remote
				// and replace would destroy a backup no one proved they own.
				await attach(gen, 'replace-local', 'resumed');
				return;
			}
			// Ask before touching anything. The password gates every resolution,
			// including 'replace': overwriting an encrypted backup demands proof
			// of ownership, or a typo away from someone's data.
			m.set({ step: 'password', busy: false, passwordError: false });
			return;
		}
		routeAfterUnlock(gen);
	}

	/** Password proven (or none needed): either ask the conflict question, or
	 *  apply the default resolution - 'merge' unless the host chose otherwise,
	 *  the only default that loses nothing on either side. */
	function routeAfterUnlock(gen: number): void {
		if (gen !== generation) return;
		if (options.hasLocalData?.() === true) {
			m.set({ step: 'conflict', busy: false });
			return;
		}
		const plan = planFor(options.defaultResolution ?? 'merge');
		void attach(gen, plan.strategy, plan.outcome);
	}

	async function attach(
		gen: number,
		strategy: 'merge' | 'replace-local' | 'replace-remote',
		outcome: ConnectFlowOutcome,
		wipe = false
	): Promise<void> {
		if (gen !== generation || !target) return;
		m.set({ busy: true });
		try {
			await withDeadline(
				host.engine.attachTarget(target, { password, strategy, wipe }),
				deadlineMs,
				'The destination'
			);
			if (gen !== generation) return;
			password = null;
			m.set({ step: 'connected', outcome, busy: false, error: null });
		} catch (e) {
			if (gen !== generation) return;
			fail(e);
		}
	}

	return {
		get snapshot() {
			return m.snapshot;
		},
		subscribe: m.subscribe,

		choose(kind: ConnectKind, variant: 'create' | 'open' = 'create'): void {
			const { step, busy } = m.snapshot;
			if (busy || (step !== 'choose' && step !== 'error')) return; // one popup per gesture
			const connector = connectorFor(kind, variant);
			if (!connector) return;
			if (
				(kind === 'webdav' && targets.webdav === true) ||
				(kind === 's3' && targets.s3 === true)
			) {
				m.set({ step: 'form', kind, error: null });
				return;
			}
			// Degraded manual mode only makes sense for CREATING a backup through
			// the built-in save picker: adopting an existing file needs the real
			// picker, and a custom connector owns its own fallback.
			const builtinCreate =
				targets.file === true ||
				(typeof targets.file === 'object' &&
					(targets.file as { create?: unknown }).create !== undefined &&
					typeof (targets.file as { create?: unknown }).create !== 'function');
			if (kind === 'file' && variant === 'create' && builtinCreate && !fileIsSupported()) {
				// No picker on this browser: degrade to download-on-demand instead of
				// a dead button.
				const gen = ++generation;
				m.set({ step: 'authorizing', kind, busy: true, error: null });
				void host.engine
					.setManualFile()
					.then(() => {
						if (gen !== generation) return;
						m.set({ step: 'connected', outcome: 'manual', busy: false });
					})
					.catch((e) => {
						if (gen !== generation) return;
						fail(e);
					});
				return;
			}
			const gen = ++generation;
			m.set({ step: 'authorizing', kind, busy: true, error: null });
			// The connector runs the human gesture (popup, picker): no deadline on
			// people. The network legs after it are bounded in inspectAndRoute.
			void connector()
				.then(async (t) => {
					if (gen !== generation) return;
					if (!t) {
						// Drive/file/custom answer null for a cancelled popup or picker:
						// not an error, no message. A FIXED webdav/s3 config answering
						// null means the server did not: that one is a retryable error.
						if (kind === 'webdav' || kind === 's3') {
							fail(
								new SelfstoreError(
									'TARGET_UNAVAILABLE',
									'The server did not answer (address, credentials or CORS).'
								)
							);
						} else {
							backToChoose();
						}
						return;
					}
					await inspectAndRoute(gen, t);
				})
				.catch((e) => {
					if (gen !== generation) return;
					fail(e);
				});
		},

		submitWebdav(config: WebdavConfig): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'form') return;
			const gen = ++generation;
			m.set({ step: 'authorizing', busy: true });
			void withDeadline(webdavConnect({ kv: host.kv, config }), deadlineMs, 'The WebDAV server')
				.then(async (t) => {
					if (gen !== generation) return;
					if (!t) {
						// webdavConnect answers null when the server does not: with an
						// explicit config this is a wrong-address error, not a cancel.
						fail(
							new SelfstoreError(
								'TARGET_UNAVAILABLE',
								'The WebDAV server did not answer (URL, credentials or CORS).'
							)
						);
						return;
					}
					await inspectAndRoute(gen, t);
				})
				.catch((e) => {
					if (gen !== generation) return;
					fail(e);
				});
		},

		submitS3(config: S3Config): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'form') return;
			const gen = ++generation;
			m.set({ step: 'authorizing', busy: true });
			void withDeadline(s3Connect({ kv: host.kv, config }), deadlineMs, 'The S3 endpoint')
				.then(async (t) => {
					if (gen !== generation) return;
					if (!t) {
						// s3Connect answers null when the endpoint does not: with an
						// explicit config this is a wrong-config error, not a cancel.
						fail(
							new SelfstoreError(
								'TARGET_UNAVAILABLE',
								'The S3 endpoint did not answer (endpoint, credentials or CORS).'
							)
						);
						return;
					}
					await inspectAndRoute(gen, t);
				})
				.catch((e) => {
					if (gen !== generation) return;
					fail(e);
				});
		},

		submitPassword(pw: string): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'password' || !target) return;
			const gen = generation;
			m.set({ busy: true, passwordError: false });
			void (async () => {
				try {
					// PROVE the password against the real backup while the store is
					// still untouched: download and trial-read. A wrong password is a
					// retype, never a locked store or a gate.
					const blob = await withDeadline(target!.load(), deadlineMs, 'The destination');
					if (gen !== generation) return;
					if (!blob) {
						throw new SelfstoreError('TARGET_UNAVAILABLE', 'The backup could not be downloaded.');
					}
					await restore(blob).withPassword(pw).read();
					if (gen !== generation) return;
					password = pw;
					m.set({ busy: false });
					routeAfterUnlock(gen);
				} catch (e) {
					if (gen !== generation) return;
					if (isSelfstoreError(e) && e.code === 'DECRYPT_FAILED') {
						m.set({ busy: false, passwordError: true }); // stay, say so, retype
						return;
					}
					fail(e);
				}
			})();
		},

		overwrite(): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'password' || !target) return;
			// The password is forgotten: stop proving it and START fresh over the
			// protected backup. wipe:true empties local first (fresh sync meta), so
			// this writes a blank new backup - never this device's existing data -
			// and the owner is never stuck behind a lost secret. A blank write is
			// also tiny, so it cannot time out the way pushing a large local store
			// would.
			password = null;
			void attach(generation, 'replace-remote', 'replaced', true);
		},

		resolveConflict(how: ConnectResolution): void {
			const { step, busy } = m.snapshot;
			if (busy || step !== 'conflict') return;
			const plan = planFor(how);
			void attach(generation, plan.strategy, plan.outcome);
		},

		cancel(): void {
			if (m.snapshot.step === 'connected') return; // done is done
			backToChoose();
		},

		retry(): void {
			if (m.snapshot.step !== 'error') return;
			backToChoose();
		}
	};
}
