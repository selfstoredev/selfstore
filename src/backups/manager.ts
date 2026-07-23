// Multi-backup manager: several backup files on one destination account, one
// attached at a time, each an isolated snapshot - opening one replaces the
// local data, never merges, never touches the other files.
//
// It owns the bookkeeping a backup panel needs: the self-healing registry of
// files this device has connected to; the per-file memories a listing cannot
// provide (encrypted? shared? - those bits live inside the files, learned as
// they are opened or probed and remembered in the kv); and the open / create
// / rename / delete gestures with their isolation invariants (fixed-id
// targets, active-id committed only after a successful attach, wipe on every
// switch so no sync-meta crosses files).
//
// Injectable and headless: a LocalStore + a kv + a BackupsHost port for the
// destination I/O. Errors surface as stable codes, never prose; hosts wrap
// subscribe in their own reactivity.

import type { KV } from '../persistence/cache';
import type { LocalStore } from '../persistence/store';
import type { BackupTarget } from '../persistence/target';
import { makeMachine, type FlowStore } from '../flows/machine';

// --- Ports --------------------------------------------------------------------

/** What the destination reports about a listed file (one cheap metadata call). */
export interface BackupFileInfo {
	id: string;
	name: string;
	/** RFC 3339 last-write timestamp, when the destination reports one. */
	modifiedTime: string | null;
}

/** The destination I/O the manager drives - the host wires its own adapter
 *  (e.g. over the Drive target ops). Every method may throw; the manager turns
 *  failures into stable error codes. */
export interface BackupsHost {
	/** The target kind the managed files live on (e.g. 'drive'): the manager
	 *  only stamps an active file while the store is attached to this kind. */
	kind: string;
	/** The kv key the attached file id is persisted under (the same one the
	 *  target's connect path reads first). */
	activeIdKey: string;
	/** List candidate backup files on the account. The manager applies the
	 *  naming rules on what comes back; internal files simply do not match. */
	list(): Promise<BackupFileInfo[]>;
	/** A target over a FIXED file id - never re-resolved by name. The fixed id
	 *  is what keeps two backups from silently merging mid-switch. */
	open(fileId: string): BackupTarget;
	/** Create an empty file under this name and return its id. Refuse a name
	 *  the account already carries (a duplicate poisons find-by-name). */
	create(fileName: string): Promise<{ fileId: string }>;
	/** Delete a file for good. */
	remove(fileId: string): Promise<void>;
	/** Rename a file in place (metadata only: the id must not change). */
	rename?(fileId: string, fileName: string): Promise<void>;
	/** Find (or create) the PERSONAL file by its canonical name, ignoring any
	 *  currently adopted id. Null when the user backs out of the session. */
	findOrCreatePersonal(): Promise<{ fileId: string; created: boolean } | null>;
	/** Make sure a usable session exists before a remote call (re-consent when
	 *  it lapsed). False = the user refused; the gesture aborts as 'cancelled'.
	 *  Absent = sessions are the target's own business. */
	ensureSession?(): Promise<boolean>;
	/** Resolve the owner label of a file this account does not own, for the
	 *  shared registry ("shared by X"). Best-effort. */
	fileOwner?(fileId: string): Promise<{ email: string | null; name: string | null } | null>;
	/** File ids that must never enter the registry even though the store may
	 *  attach them (e.g. a sharing engine's published copy file). */
	excludedFileIds?(): Promise<(string | null | undefined)[]>;
}

/** How backup files are named on the destination. */
export interface BackupsNaming {
	/** The personal, unnamed file ("App.zip"). Its label reads as null. */
	canonicalName: string;
	/** label -> file name. Default: "Stem (label).ext" derived from
	 *  canonicalName ("App.zip" + "family" -> "App (family).zip"). */
	namedFileFor?(label: string): string;
	/** file name -> parsed label; null = the personal file; undefined = not one
	 *  of ours (dropped from listings). Default matches the default namedFileFor. */
	parseLabel?(name: string): string | null | undefined;
}

/** The kv keys the manager persists under - override to keep a pre-existing
 *  install's records. */
export interface BackupsKeys {
	/** The known-backups registry. */
	registry?: string;
	/** fileId -> encrypted? map. */
	encrypted?: string;
	/** fileId -> shared? map. */
	shared?: string;
	/** Set while the ACTIVE file is not the personal one (another account's). */
	joined?: string;
	/** Cached owner label of that file. */
	owner?: string;
}

// --- Shapes -------------------------------------------------------------------

/** Every backup this device has connected to: its own personal file and each
 *  OTHER account's file it was let into. Isolated snapshots, all of them. */
export interface KnownBackups {
	personalFileId: string | null;
	shared: { fileId: string; ownerEmail: string | null; ownerName: string | null }[];
}

/** One row of the "my backups" list: a file this account owns. */
export interface BackupRow {
	fileId: string;
	name: string;
	/** Parsed display label; null for the personal, unnamed file. */
	label: string | null;
	/** Last-write time, epoch ms (null when the destination did not say). */
	modifiedAt: number | null;
	/** true/false once known (opened, created or probed); null until then. */
	encrypted: boolean | null;
	/** true/false once learned (while this file was the active one); null
	 *  until then. A share link existing is the shared state. */
	shared: boolean | null;
}

/** The owner label of a joined (another account's) file. */
export interface BackupOwner {
	email: string | null;
	name: string | null;
}

/** Stable failure codes; the host maps them to its own copy. */
export type BackupsErrorCode = 'cancelled' | 'gone' | 'failed';

export interface BackupsSnapshot {
	registry: KnownBackups;
	/** The file currently attached, when the store is on the managed kind. */
	activeFileId: string | null;
	/** The active file is not the personal one (someone else's). */
	joined: boolean;
	/** Who owns the joined file, when known. */
	owner: BackupOwner | null;
	/** The last gesture's failure, or null. Reset at each gesture start. */
	lastError: BackupsErrorCode | null;
}

export interface BackupsManager extends FlowStore<BackupsSnapshot> {
	/** Boot: load registry + joined/owner from kv and stamp the active file.
	 *  Kv-only, no destination call. */
	hydrate(): Promise<void>;
	/** Re-read the registry and restamp the active file. Kv-only, cheap. */
	refresh(): Promise<void>;
	/** After an attach the manager did not make (a connect widget, a join):
	 *  record the now-active file in the registry and restamp joined/owner. */
	markActive(fileId: string): Promise<void>;
	/** Live list of this account's own files, per the naming rules, decorated
	 *  with the learned memories. One destination listing call. */
	list(): Promise<BackupRow[]>;
	/** Learn a listed file's encrypted bit without opening it for real: one
	 *  download + header read, remembered for good. Null when unreachable. */
	probeEncryption(fileId: string): Promise<boolean | null>;
	/** Record the ACTIVE file's live share state, keyed by file id, so its row
	 *  stays truthful after a switch away. */
	noteShared(fileId: string, shared: boolean): Promise<void>;
	/** Open a known backup: an isolated snapshot replaces the local data.
	 *  'encrypted' = collect its passphrase and call again with it. A file the
	 *  destination reports GONE is pruned from the registry (lastError 'gone'). */
	openBackup(fileId: string, passphrase?: string | null): Promise<'ok' | 'encrypted' | 'failed'>;
	/** Open (or create blank) the personal file. */
	openPersonal(passphrase?: string | null): Promise<'ok' | 'encrypted' | 'failed'>;
	/** Create a brand-new empty named backup and open it (starts blank - never
	 *  seeded from the currently loaded file). */
	createNamed(label: string): Promise<'ok' | 'failed'>;
	/** Record a file in the SHARED registry under the sharer's label, without
	 *  opening it. For a joined portfolio's dedicated wallet: the file may live
	 *  on this very account, yet it presents as "shared by X", never as mine. */
	registerShared(fileId: string, owner: BackupOwner): Promise<void>;
	/** Create a joined portfolio's dedicated wallet: a file under the given
	 *  name (outside the own-files naming on purpose), attached BLANK - never
	 *  seeded from the previously loaded silo - and recorded in the shared
	 *  registry under the sharer's label. The host stages the shared content
	 *  afterwards (restore the projection, then save). */
	createShared(fileName: string, owner: BackupOwner): Promise<'ok' | 'failed'>;
	/** Rename a file in place (id unchanged, so renaming the ACTIVE file never
	 *  detaches it). The host target refuses a name already carried. */
	renameBackup(fileId: string, label: string): Promise<'ok' | 'failed'>;
	/** Delete a file for good. Deleting the ACTIVE one detaches first (the app
	 *  goes device-only, local data stays), so nothing writes mid-delete. */
	deleteBackup(fileId: string): Promise<boolean>;
	/** Drop a KNOWN shared (another account's) file from this device's
	 *  registry. Forgetting only - the owner's file is never touched. */
	forgetShared(fileId: string): Promise<void>;
	/** The file name a label produces (the create form's preview line). */
	fileNameFor(label: string): string;
}

// --- Defaults -----------------------------------------------------------------

const DEFAULT_KEYS: Required<BackupsKeys> = {
	registry: 'selfstore:backups:registry:v1',
	encrypted: 'selfstore:backups:encrypted:v1',
	shared: 'selfstore:backups:shared:v1',
	joined: 'selfstore:backups:joined:v1',
	owner: 'selfstore:backups:owner:v1'
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The default naming scheme: "App.zip" -> personal; "App (label).zip" ->
 *  named. Derived from the canonical name's stem and extension. */
function defaultNaming(naming: BackupsNaming): Required<Pick<BackupsNaming, 'namedFileFor' | 'parseLabel'>> {
	const dot = naming.canonicalName.lastIndexOf('.');
	const stem = dot > 0 ? naming.canonicalName.slice(0, dot) : naming.canonicalName;
	const ext = dot > 0 ? naming.canonicalName.slice(dot) : '';
	const named = new RegExp(`^${escapeRe(stem)} \\((.+)\\)${escapeRe(ext)}$`);
	return {
		namedFileFor: (label: string) => `${stem} (${label.trim()})${ext}`,
		parseLabel: (name: string) => {
			if (name === naming.canonicalName) return null;
			const m = named.exec(name);
			return m ? m[1] : undefined;
		}
	};
}

// --- Factory ------------------------------------------------------------------

export function createBackupsManager(deps: {
	store: LocalStore;
	kv: KV;
	host: BackupsHost;
	naming: BackupsNaming;
	keys?: BackupsKeys;
}): BackupsManager {
	const { store, kv, host } = deps;
	const KEYS = { ...DEFAULT_KEYS, ...deps.keys };
	const namingDefaults = defaultNaming(deps.naming);
	const naming = {
		namedFileFor: deps.naming.namedFileFor ?? namingDefaults.namedFileFor,
		parseLabel: deps.naming.parseLabel ?? namingDefaults.parseLabel
	};

	const m = makeMachine<BackupsSnapshot>({
		registry: { personalFileId: null, shared: [] },
		activeFileId: null,
		joined: false,
		owner: null,
		lastError: null
	});

	const fail = (code: BackupsErrorCode): void => m.set({ lastError: code });

	// Which file ids the destination lists as OURS, and which one carries the
	// canonical (personal) name. Filled by list(), refreshed lazily where a
	// truthful own/foreign call is needed. Null until first learned.
	let ownIds: Set<string> | null = null;
	let ownCanonicalId: string | null = null;

	function learnOwn(files: BackupFileInfo[]): void {
		const ids = new Set<string>();
		let canonical: string | null = null;
		for (const f of files) {
			const label = naming.parseLabel(f.name);
			if (label === undefined) continue;
			ids.add(f.id);
			if (label === null) canonical = f.id;
		}
		ownIds = ids;
		ownCanonicalId = canonical;
	}

	async function ensureOwnKnown(): Promise<void> {
		if (ownIds !== null) return;
		try {
			learnOwn(await host.list());
		} catch {
			// Offline: leave unknown - markActive falls back on the registry alone.
		}
	}

	/** Load the registry, self-healing: excluded ids (a sharing engine's copy
	 *  file) must never sit in it - recorded as "personal" they would mislabel
	 *  the chooser and let a later open treat a shared file as one's own. */
	async function loadRegistry(): Promise<KnownBackups> {
		const reg = (await kv.get<KnownBackups>(KEYS.registry)) ?? { personalFileId: null, shared: [] };
		const excluded = (await host.excludedFileIds?.()) ?? [];
		const bad = new Set(excluded.filter((x): x is string => typeof x === 'string'));
		if (bad.size === 0) return reg;
		const healed: KnownBackups = {
			personalFileId: reg.personalFileId && bad.has(reg.personalFileId) ? null : reg.personalFileId,
			shared: reg.shared.filter((s) => !bad.has(s.fileId))
		};
		if (healed.personalFileId !== reg.personalFileId || healed.shared.length !== reg.shared.length) {
			await kv.set(KEYS.registry, healed);
		}
		return healed;
	}

	async function saveRegistry(next: KnownBackups): Promise<void> {
		m.set({ registry: next });
		await kv.set(KEYS.registry, next);
	}

	async function noteEncrypted(fileId: string, encrypted: boolean): Promise<void> {
		const map = (await kv.get<Record<string, boolean>>(KEYS.encrypted)) ?? {};
		if (map[fileId] === encrypted) return;
		map[fileId] = encrypted;
		await kv.set(KEYS.encrypted, map);
	}

	/** Stamp the currently attached file (from the target's own persisted id)
	 *  into the snapshot and the registry. Kv-only. */
	async function registerActive(): Promise<void> {
		if (store.state.targetKind !== host.kind) {
			m.set({ activeFileId: null });
			return;
		}
		const fileId = (await kv.get<string>(host.activeIdKey)) ?? null;
		m.set({ activeFileId: fileId });
		if (!fileId) return;
		const excluded = (await host.excludedFileIds?.()) ?? [];
		if (excluded.includes(fileId)) return;
		const reg = await loadRegistry();
		if (m.snapshot.joined) {
			const owner = m.snapshot.owner;
			const entry = { fileId, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null };
			await saveRegistry({
				personalFileId: reg.personalFileId === fileId ? null : reg.personalFileId,
				shared: [entry, ...reg.shared.filter((s) => s.fileId !== fileId)]
			});
			return;
		}
		// Not joined. The personal slot belongs to the CANONICAL file alone: an
		// own NAMED backup lists live and must not clobber it (the slot is the
		// escape back to the personal file).
		const canonical =
			fileId === ownCanonicalId || reg.personalFileId === fileId || (ownIds === null && reg.personalFileId === null);
		if (canonical) {
			await saveRegistry({
				personalFileId: fileId,
				shared: reg.shared.filter((s) => s.fileId !== fileId)
			});
		} else if (reg.shared.some((s) => s.fileId === fileId)) {
			await saveRegistry({
				personalFileId: reg.personalFileId,
				shared: reg.shared.filter((s) => s.fileId !== fileId)
			});
		}
	}

	/** Session guard shared by the remote gestures: absent hook = no guard. */
	async function ensureSession(): Promise<boolean> {
		if (!host.ensureSession) return true;
		return host.ensureSession();
	}

	async function markActive(fileId: string): Promise<void> {
		const reg = await loadRegistry();
		const knownShared = reg.shared.find((s) => s.fileId === fileId);
		let mine = reg.personalFileId === fileId;
		if (!mine && !knownShared) {
			// Unknown file: ask the destination whose it is (one listing call,
			// cached). An own named backup must never read as joined - labeled
			// "shared by me", it would sit in the wrong section for good.
			await ensureOwnKnown();
			mine = ownIds === null ? reg.personalFileId === null : ownIds.has(fileId);
		}
		if (mine || (!knownShared && ownIds?.has(fileId))) {
			await kv.del(KEYS.joined);
			await kv.del(KEYS.owner);
			m.set({ joined: false, owner: null });
		} else {
			const owner: BackupOwner | null = knownShared
				? { email: knownShared.ownerEmail, name: knownShared.ownerName }
				: ((await host.fileOwner?.(fileId).catch(() => null)) ?? null);
			m.set({ joined: true, owner });
			await kv.set(KEYS.joined, true);
			if (owner) await kv.set(KEYS.owner, owner);
			else await kv.del(KEYS.owner);
		}
		await registerActive();
	}

	/** The one attach path every open shares: FIXED-id target, and the
	 *  remembered id committed only after the attach succeeds - committed up
	 *  front, the OUTGOING target (which resolves its file lazily from that
	 *  same key) would flush the old file's data into the one being opened:
	 *  two "isolated" backups silently merged. `wipe` keeps sync-meta from
	 *  crossing files (cross-file tombstones erase the other side). */
	async function attachFixed(
		fileId: string,
		passphrase: string | null,
		strategy: 'replace-local' | 'replace-remote'
	): Promise<void> {
		const target = host.open(fileId);
		await store.attachTarget(target, {
			password: passphrase,
			strategy,
			keepSession: store.state.targetKind === host.kind,
			wipe: true
		});
		await kv.set(host.activeIdKey, fileId);
	}

	return {
		get snapshot() {
			return m.snapshot;
		},
		subscribe: m.subscribe,

		fileNameFor(label: string): string {
			return naming.namedFileFor(label.trim());
		},

		async hydrate(): Promise<void> {
			const joined = (await kv.get(KEYS.joined)) === true;
			const owner = (await kv.get<BackupOwner>(KEYS.owner)) ?? null;
			m.set({ joined, owner, registry: await loadRegistry() });
			await registerActive();
		},

		async refresh(): Promise<void> {
			m.set({ registry: await loadRegistry() });
			await registerActive();
		},

		markActive,

		async list(): Promise<BackupRow[]> {
			const files = await host.list();
			learnOwn(files);
			const enc = (await kv.get<Record<string, boolean>>(KEYS.encrypted)) ?? {};
			const shr = (await kv.get<Record<string, boolean>>(KEYS.shared)) ?? {};
			const rows: BackupRow[] = [];
			for (const f of files) {
				const label = naming.parseLabel(f.name);
				if (label === undefined) continue; // not one of ours (a copy, a bulletin, ...)
				rows.push({
					fileId: f.id,
					name: f.name,
					label,
					modifiedAt: f.modifiedTime ? Date.parse(f.modifiedTime) || null : null,
					encrypted: enc[f.id] ?? null,
					shared: shr[f.id] ?? null
				});
			}
			return rows;
		},

		async probeEncryption(fileId: string): Promise<boolean | null> {
			try {
				const info = await store.inspectTarget(host.open(fileId));
				if (!info.hasBackup) return null;
				await noteEncrypted(fileId, info.encrypted);
				return info.encrypted;
			} catch {
				return null;
			}
		},

		async noteShared(fileId: string, shared: boolean): Promise<void> {
			const map = (await kv.get<Record<string, boolean>>(KEYS.shared)) ?? {};
			if (map[fileId] === shared) return;
			map[fileId] = shared;
			await kv.set(KEYS.shared, map);
		},

		async openBackup(fileId, passphrase = null): Promise<'ok' | 'encrypted' | 'failed'> {
			m.set({ lastError: null });
			try {
				if (!(await ensureSession())) {
					fail('cancelled');
					return 'failed';
				}
				const info = await store.inspectTarget(host.open(fileId));
				if (!info.hasBackup) {
					// Dead entry (deleted, or unshared from this account): prune it so
					// its row stops re-failing forever. A transient failure throws
					// instead and never prunes - dropping a good record on a blip
					// would be far worse than one more failed tap.
					const reg = await loadRegistry();
					await saveRegistry({
						personalFileId: reg.personalFileId === fileId ? null : reg.personalFileId,
						shared: reg.shared.filter((s) => s.fileId !== fileId)
					});
					fail('gone');
					return 'failed';
				}
				await noteEncrypted(fileId, info.encrypted); // the listing cannot tell
				if (info.encrypted && !passphrase) return 'encrypted';
				await attachFixed(fileId, passphrase, 'replace-local');
				await markActive(fileId);
				return store.state.locked ? 'encrypted' : 'ok';
			} catch {
				fail('failed');
				return 'failed';
			}
		},

		async openPersonal(passphrase = null): Promise<'ok' | 'encrypted' | 'failed'> {
			m.set({ lastError: null });
			try {
				const own = await host.findOrCreatePersonal();
				if (!own) {
					fail('cancelled');
					return 'failed';
				}
				ownCanonicalId = own.fileId;
				ownIds?.add(own.fileId);
				const reg = await loadRegistry();
				await saveRegistry({
					personalFileId: own.fileId,
					shared: reg.shared.filter((s) => s.fileId !== own.fileId)
				});
				if (!own.created) return await this.openBackup(own.fileId, passphrase);
				await attachFixed(own.fileId, null, 'replace-remote');
				await markActive(own.fileId);
				return 'ok';
			} catch {
				fail('failed');
				return 'failed';
			}
		},

		async createNamed(label): Promise<'ok' | 'failed'> {
			m.set({ lastError: null });
			const clean = label.trim();
			if (!clean) {
				fail('failed');
				return 'failed';
			}
			try {
				if (!(await ensureSession())) {
					fail('cancelled');
					return 'failed';
				}
				const { fileId } = await host.create(naming.namedFileFor(clean));
				ownIds?.add(fileId);
				await attachFixed(fileId, null, 'replace-remote');
				await noteEncrypted(fileId, false); // a fresh backup starts unprotected
				await markActive(fileId);
				return 'ok';
			} catch {
				fail('failed');
				return 'failed';
			}
		},

		async registerShared(fileId, owner): Promise<void> {
			const reg = await loadRegistry();
			await saveRegistry({
				personalFileId: reg.personalFileId === fileId ? null : reg.personalFileId,
				shared: [
					{ fileId, ownerEmail: owner.email, ownerName: owner.name },
					...reg.shared.filter((s) => s.fileId !== fileId)
				]
			});
		},

		async createShared(fileName, owner): Promise<'ok' | 'failed'> {
			m.set({ lastError: null });
			try {
				if (!(await ensureSession())) {
					fail('cancelled');
					return 'failed';
				}
				const { fileId } = await host.create(fileName);
				// Registered as shared BEFORE the attach: markActive must find it in
				// the shared registry, or it would resolve this account as the owner
				// and file the joined wallet under "mine".
				await this.registerShared(fileId, owner);
				await attachFixed(fileId, null, 'replace-remote');
				await noteEncrypted(fileId, false); // a member wallet is never protected
				await markActive(fileId);
				return 'ok';
			} catch {
				fail('failed');
				return 'failed';
			}
		},

		async renameBackup(fileId, label): Promise<'ok' | 'failed'> {
			m.set({ lastError: null });
			const clean = label.trim();
			if (!clean || !host.rename) {
				fail('failed');
				return 'failed';
			}
			try {
				await host.rename(fileId, naming.namedFileFor(clean));
				return 'ok';
			} catch {
				fail('failed');
				return 'failed';
			}
		},

		async deleteBackup(fileId): Promise<boolean> {
			m.set({ lastError: null });
			try {
				if (fileId === m.snapshot.activeFileId) {
					// Detach first: the app goes device-only (local data stays) so
					// nothing writes to the file as it is removed. keepSession: a
					// default detach runs the target's disconnect, which forgets the
					// destination credentials - the remove below still needs them,
					// and the user deleted a FILE, not their account connection.
					m.set({ activeFileId: null });
					await store.detachTarget({ keepSession: true });
					// The remembered file id would normally be cleared by that
					// disconnect; do it here so nothing dangles on a deleted file.
					await kv.del(host.activeIdKey);
				}
				await host.remove(fileId);
				const reg = await loadRegistry();
				await saveRegistry({
					personalFileId: reg.personalFileId === fileId ? null : reg.personalFileId,
					shared: reg.shared.filter((s) => s.fileId !== fileId)
				});
				return true;
			} catch {
				fail('failed');
				return false;
			}
		},

		async forgetShared(fileId): Promise<void> {
			const reg = await loadRegistry();
			await saveRegistry({
				personalFileId: reg.personalFileId,
				shared: reg.shared.filter((s) => s.fileId !== fileId)
			});
		}
	};
}
