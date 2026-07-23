// The backup-copy journey: attach ONE replica (a second destination receiving
// the same encrypted backup as the primary home) behind a small state machine
// the widgets can render. Reuses the connect flow's target specs, but there is
// no password step, no conflict step and no deadline: a replica carries the
// primary's bytes as-is, and every connector may contain a human gesture.

import type { BackupTarget } from '../persistence/target';
import type { KV } from '../persistence/cache';
import type { ReplicaState, StoreError } from '../persistence/store';
import { makeMachine, toStoreError, type FlowStore } from './machine';
import type { ConnectKind, ConnectTargets, Connector, FlowHost } from './connect';
import {
	connect as driveConnect,
	fromSession as driveFromSession,
	type DriveAuth
} from '../persistence/targets/drive';
import { connect as fileConnect, fromSession as fileFromSession } from '../persistence/targets/file';
import {
	connect as webdavConnect,
	fromSession as webdavFromSession,
	type WebdavConfig
} from '../persistence/targets/webdav';
import { connect as s3Connect, fromSession as s3FromSession, type S3Config } from '../persistence/targets/s3';

/** The one replica this flow manages, as its id on the engine. */
export const REPLICA_ID = 'replica';

// The replica's target session lives in the SAME kv as the primary's, so every
// key is prefixed: a second driveTarget (say) must never read or clobber the
// primary connection's session keys.
const SCOPE = 'replica:';
const RECORD_KEY = 'record';

/** What survives a reboot: which provider the copy lives on. The target's own
 *  session (file id, handle, server config) is persisted by the target module
 *  itself, under the scoped kv. */
interface ReplicaRecord {
	kind: ConnectKind;
}

export type ReplicaStep = 'idle' | 'choose' | 'form-webdav' | 'form-s3';

export interface ReplicaSnapshot {
	step: ReplicaStep;
	/** The kinds the host offers, in ConnectTargets order. */
	kinds: ConnectKind[];
	busy: boolean;
	error: StoreError | null;
	/** The live engine entry (label, lastPublishAt, lastError), null when none. */
	replica: ReplicaState | null;
}

export interface ReplicaFlowOptions {
	/** File name of the copy on its destination. Default: the primary backup
	 *  name with `.replica` before the extension ("App.zip" -> "App.replica.zip"),
	 *  which a same-account Drive never confuses with the primary file and the
	 *  backups panel never lists as a backup of its own. */
	fileName?: string;
	/** Rebuild the target of a custom Connector kind on restore() (built-in
	 *  kinds rebuild by themselves). Without it, custom kinds are not restored. */
	restoreTarget?: (kind: ConnectKind) => Promise<BackupTarget | null>;
}

export interface ReplicaFlow extends FlowStore<ReplicaSnapshot> {
	/** Show the destination choice (from the user's gesture). */
	open(): void;
	/** Back to idle; never an error. */
	cancel(): void;
	/** Run a destination (inside the user's click - pickers and consent popups
	 *  open from it). `webdav: true` / `s3: true` route to their form step. */
	pick(kind: ConnectKind): void;
	/** 'form-webdav' step: submit the server config. */
	submitWebdav(config: WebdavConfig): void;
	/** 'form-s3' step: submit the bucket config. */
	submitS3(config: S3Config): void;
	/** Detach the copy and forget its session. Never deletes remote data. */
	remove(): Promise<void>;
	/** Silent reboot: re-attach the copy recorded by a past session, if any.
	 *  Never throws - an unreachable destination retries at the next boot. */
	restore(): Promise<void>;
	/** Detach from the engine (the replica itself stays attached). */
	dispose(): void;
}

function scopedKv(kv: KV, prefix: string): KV {
	return {
		get: <T = unknown>(key: string) => kv.get<T>(prefix + key),
		set: (key: string, value: unknown) => kv.set(prefix + key, value),
		del: (key: string) => kv.del(prefix + key)
	};
}

function replicaFileName(backupName: string): string {
	const dot = backupName.lastIndexOf('.');
	return dot > 0
		? `${backupName.slice(0, dot)}.replica${backupName.slice(dot)}`
		: `${backupName}.replica`;
}

export function replicaFlow(
	store: FlowHost | { flowHost: FlowHost },
	targets: ConnectTargets,
	options: ReplicaFlowOptions = {}
): ReplicaFlow {
	const host = 'flowHost' in store ? store.flowHost : store;
	const engine = host.engine;
	const skv = scopedKv(host.kv, SCOPE);
	const fileName = options.fileName ?? replicaFileName(host.backupName);
	const kinds = (Object.keys(targets) as ConnectKind[]).filter(
		(k) => (k === 'drive' || k === 'file' || k === 'webdav' || k === 's3') && targets[k] != null
	);

	const current = (): ReplicaState | null =>
		engine.state.replicas.find((r) => r.id === REPLICA_ID) ?? null;

	const m = makeMachine<ReplicaSnapshot>({
		step: 'idle',
		kinds,
		busy: false,
		error: null,
		replica: current()
	});

	// Follow the engine: every publish (or publish failure) refreshes the entry.
	const unsub = engine.subscribe(() => m.set({ replica: current() }));

	// Held for remove(): disconnect() lets the target forget its own session.
	let attached: BackupTarget | null = null;

	function connectorFor(kind: ConnectKind): Connector | null {
		const spec = targets[kind];
		if (spec == null) return null;
		if (typeof spec === 'function') return spec;
		if (kind === 'drive') {
			const auth = spec as DriveAuth;
			return () => driveConnect({ auth, kv: skv, fileName });
		}
		if (kind === 'file') {
			return () => fileConnect({ kv: skv, fileName });
		}
		if (kind === 's3') {
			const config = spec as S3Config; // 's3: true' goes through the form step
			return () => s3Connect({ kv: skv, config });
		}
		const config = spec as WebdavConfig; // 'webdav: true' goes through the form step
		return () => webdavConnect({ kv: skv, config });
	}

	async function run(kind: ConnectKind, connector: Connector): Promise<void> {
		m.set({ busy: true, error: null });
		try {
			const target = await connector();
			if (!target) {
				// Cancelled picker/consent: stay where the user was, no error.
				m.set({ busy: false });
				return;
			}
			if (current()) engine.detachReplica(REPLICA_ID); // swap, never a dup-id throw
			engine.attachReplica(target, { id: REPLICA_ID });
			attached = target;
			await skv.set(RECORD_KEY, { kind } satisfies ReplicaRecord);
			m.set({ step: 'idle', busy: false, error: null, replica: current() });
		} catch (e) {
			m.set({ busy: false, error: toStoreError(e) });
		}
	}

	async function builtinFromSession(kind: ConnectKind): Promise<BackupTarget | null> {
		if (kind === 'drive') {
			const spec = targets.drive;
			if (spec == null || typeof spec === 'function') return null;
			return driveFromSession({ auth: spec, kv: skv, fileName });
		}
		if (kind === 'file') return fileFromSession({ kv: skv });
		if (kind === 'webdav') return webdavFromSession({ kv: skv });
		return s3FromSession({ kv: skv });
	}

	return {
		get snapshot() {
			return m.snapshot;
		},
		subscribe: m.subscribe,

		open() {
			if (m.snapshot.busy) return;
			m.set({ step: 'choose', error: null });
		},

		cancel() {
			m.set({ step: 'idle', busy: false, error: null });
		},

		pick(kind) {
			if (m.snapshot.busy) return;
			const spec = targets[kind];
			if (spec == null) return;
			if (kind === 'webdav' && spec === true) {
				m.set({ step: 'form-webdav', error: null });
				return;
			}
			if (kind === 's3' && spec === true) {
				m.set({ step: 'form-s3', error: null });
				return;
			}
			const connector = connectorFor(kind);
			if (connector) void run(kind, connector);
		},

		submitWebdav(config) {
			if (m.snapshot.busy) return;
			void run('webdav', () => webdavConnect({ kv: skv, config }));
		},

		submitS3(config) {
			if (m.snapshot.busy) return;
			void run('s3', () => s3Connect({ kv: skv, config }));
		},

		async remove() {
			const target = attached;
			attached = null;
			if (current()) engine.detachReplica(REPLICA_ID);
			await skv.del(RECORD_KEY);
			// Forget locally only - a BackupTarget's disconnect never deletes
			// remote data, so the copy stays where it is for a manual recovery.
			await target?.disconnect().catch(() => undefined);
			m.set({ step: 'idle', busy: false, error: null, replica: current() });
		},

		async restore() {
			try {
				if (current()) return;
				const record = await skv.get<ReplicaRecord>(RECORD_KEY);
				if (!record) return;
				const target =
					(await options.restoreTarget?.(record.kind)) ?? (await builtinFromSession(record.kind));
				if (!target) return; // unreachable or custom kind: retry next boot
				engine.attachReplica(target, { id: REPLICA_ID });
				attached = target;
				m.set({ replica: current() });
			} catch {
				// Silent reboot by contract: the record stays, the next boot retries.
			}
		},

		dispose() {
			unsub();
		}
	};
}
