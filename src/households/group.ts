// Household sharing, mirror model: read-write while every member's own file
// stays exactly what its owner chose. Each member publishes a dedicated copy
// of their file sealed under the link key K (a selfstore mirror, republished
// after every save that moved data), and attaches the others' copies as
// read-only peers keyed by K - reading the other's copy is what
// resynchronizes. A password-protected store refuses to share, honestly.
//
// The invitation link carries K in its fragment; possession of K is
// membership, no per-member identity. Revoking means ending the share (the
// one real revocation, see leave()); everyone keeps what already converged
// into their own file - the local-first reality.
//
// A device may hold SEVERAL memberships, one per share, each bound to its own
// wallet file (the `wallet` getter): at most the in-scope one is armed, the
// others lie dormant. Without the getter (single-wallet hosts) the engine
// keeps the historical one-membership rule.
//
// Injectable by contract (store / kv / backend), framework-free,
// network-free: every durable side effect goes through store or backend.

import { randomId, type CopyLink, type SharePayload } from './codec';
import type { BackupTarget, PeerSource } from '../persistence/target';
import type { KV } from '../persistence/cache';
import type { LocalStore } from '../persistence/store';

// --- Injected abstractions --------------------------------------------------

/** What the bulletin holds once opened: the read-only projection (scrubbed
 *  collections, empty when the share is revoked) and the control record. */
export interface IncomingShare {
	projection: Record<string, unknown[]>;
	share: SharePayload;
}

/**
 * The sharing transport, the sole Drive/relay/mailbox-specific seam. A test
 * provides an in-memory fake; the host app provides a real one (e.g. Drive).
 * Everything here carries only public data - file ids and the roster.
 */
export interface ShareBackend {
	/** Create this member's dedicated copy file (link-readable, empty until the
	 *  mirror publishes into it) and return the link others read it through.
	 *  `existingFileId` reuses a known copy on restore instead of minting a
	 *  second file. */
	createCopy(existingFileId?: string, shareLabel?: string): Promise<CopyLink>;
	/** A write-capable target over a copy file, for the store MIRROR. Never
	 *  adopted as the store's own target - the store's own connection stays what
	 *  it is. */
	copyTarget(fileId: string): BackupTarget;
	/** Teardown: make a copy file private and delete it (best-effort). Only
	 *  ever called on MY own copy - the others' files are theirs. */
	dropCopy(fileId: string): Promise<void>;
	/** Admin: write (or rewrite) the bulletin - the encrypted file the invitation
	 *  link points at, holding the read-only projection plus the control record.
	 *  Idempotent per group; returns where it lives (the link's fileId + key). */
	publishBulletin(key: string, payload: SharePayload): Promise<{ fileId: string; key: string }>;
	/** Admin: stop the invitation - the bulletin drops its projection and roster,
	 *  so the link no longer previews or admits. */
	revokeBulletin(): Promise<void>;
	/** Open an invitation link's bulletin (through the relay) and STASH it for the
	 *  join, returning its content for the read-only preview. Null when the link
	 *  is dead or the key wrong. */
	openIncoming(fileId: string, key: string): Promise<IncomingShare | null>;
	/** The invitation opened by openIncoming and stashed for the join, or null. */
	takeStashedIncoming(): Promise<{ key: string; fileId: string; content: IncomingShare } | null>;
	/** Re-read a joined share's bulletin (member): the freshest roster. The
	 *  engine passes the invitation capability it joined through, so every
	 *  membership rereads ITS bulletin. Null when unreachable or revoked -
	 *  nothing is concluded. The literal 'unreadable' when the bulletin WAS
	 *  fetched but cannot be opened (the key no longer decrypts it - the admin
	 *  rotated the link): the engine counts consecutive ones toward the stale
	 *  verdict. A backend that cannot tell may keep returning null; the stale
	 *  detection then simply never fires. */
	rereadJoined(fileId: string, key: string): Promise<SharePayload | null | 'unreadable'>;
	/** Member: announce my copy to the group's mailbox so the admin folds it. */
	announce(mailboxId: string, copy: CopyLink): Promise<void>;
	/** Admin: drain the announce mailbox - the copies members published. */
	takeAnnounces(mailboxId: string): Promise<CopyLink[]>;
	/** A read-only PeerSource over another member's published copy. */
	peerSource(link: CopyLink): PeerSource;
}

// --- Persisted group ----------------------------------------------------------

/** Everything needed to re-arm ONE share on reboot. A device may hold several
 *  (one per joined silo); they persist together under the single KV key. */
interface StoredGroup {
	role: 'admin' | 'member';
	/** The wallet FILE this share is bound to (captured at start/join when the
	 *  host injects `wallet`). The mirror and peers arm only while it is the
	 *  attached one: another silo's data must never publish into the copy, and
	 *  the shared data must never fold into another silo. Absent = unbound
	 *  (single-wallet hosts), the share follows the store wherever it points. */
	walletFileId?: string;
	/** The shared group key K (the invitation link's fragment key). */
	key: string;
	/** Where members announce their copy (a secret only K-holders read). */
	mailboxId: string;
	/** Known copies (the admin's own first). */
	roster: CopyLink[];
	/** My own published copy (never the member's own file). */
	myCopy: CopyLink;
	/** Admin: where the bulletin lives - what the link carries. Member: the
	 *  invitation opened to join - the roster refresh rereads it. (Absent on
	 *  pre-multi member records: their refresh stays dormant until a re-join.) */
	bulletin?: { fileId: string; key: string };
	/** Admin only: false once revoked (the bulletin stops previewing/admitting). */
	live?: boolean;
	/** Admin only: a roster change could not be rebroadcast (offline mid-fold);
	 *  the next converge republishes even though nothing new was folded. */
	needsRebroadcast?: boolean;
	/** Member only: my copy has not been SEEN in a fresh roster yet - the join
	 *  announce (or a later one) may have been lost. While set, every converge
	 *  re-announces, readable bulletin or not, so a joiner whose first announce
	 *  died on a network blip still becomes visible without re-opening the
	 *  invitation. Cleared the moment a fresh roster carries my copy. */
	announcePending?: boolean;
	/** Member only: consecutive rereads whose bulletin was FETCHED but no longer
	 *  decrypts under my key. Two in a row set `stale` (one bad read must not
	 *  condemn a share over a hiccup); any readable read resets both. */
	unreadableReads?: number;
	/** Member only: the admin rotated the link (see unreadableReads) - my edits
	 *  publish into a copy nobody folds anymore. The host should surface "this
	 *  share was renewed, ask for a fresh invitation" instead of letting the
	 *  member edit into the void. */
	stale?: boolean;
}

/** The persisted shape: every membership on this device. A lone pre-multi
 *  record lifts into a one-entry list on first load. */
interface StoredGroups {
	v: 2;
	groups: StoredGroup[];
}

/** The default KV key the group lives under. Exported so a caller can wipe
 *  it. Hosts with a pre-existing record under another key pass `storageKey`. */
export const HOUSEHOLD_GROUP_KEY = 'selfstore:households:group:v1';

/** Every membership publishes through its own mirror: the id is scoped by the
 *  copy file (unique per share) so several never collide on one store. */
const mirrorId = (group: StoredGroup): string => `household-copy:${group.myCopy.fileId}`;

// --- Public surface -----------------------------------------------------------

/** One membership, as the UI lists them: which silo carries it and whose
 *  share it is. */
export interface MembershipInfo {
	/** The wallet file this membership is bound to (null = unbound legacy). */
	walletFileId: string | null;
	isAdmin: boolean;
	/** My published copy's file id for this share. */
	selfFileId: string;
	/** Who shares it with me (the admin's roster label); null for my own share. */
	sharedBy: string | null;
	memberCount: number;
	/** Member: my copy is not in a fresh roster yet (the announce may have been
	 *  lost; the engine keeps re-announcing). The host can show "waiting for the
	 *  admin to see you" instead of a false everything-is-fine. */
	announcePending: boolean;
	/** Member: the admin rotated the link - edits publish into the void until a
	 *  fresh invitation is joined. The host must surface it. */
	stale: boolean;
}

/** The reactive-friendly snapshot the UI reads (hosts wrap it in their own
 *  reactivity - a Svelte rune, a React store, anything). The singular fields
 *  describe the PRIMARY membership (the admin one when it exists, else the
 *  first); `memberships` lists them all. */
export interface HouseholdGroupState {
	/** A share exists on this device (admin or member). */
	active: boolean;
	isAdmin: boolean;
	/** How many copies are in the roster (this device included). */
	memberCount: number;
	/** The roster's cosmetic owner labels, for a "who has access" list. */
	members: { fileId: string; label: string }[];
	/** My own copy's file id, so the UI can list everyone ELSE. */
	selfFileId: string | null;
	/** The wallet file the share is bound to, or null when unbound. The host
	 *  compares it to its own attached-file id to render "this silo carries the
	 *  share" and to gate its own publications the same way the engine does. */
	walletFileId: string | null;
	/** Admin: the live invitation's capability, so the panel can re-show the
	 *  link without republishing anything. */
	inviteCapability: { fileId: string; key: string } | null;
	/** Every membership on this device, admin and joined alike. */
	memberships: MembershipInfo[];
}

export interface HouseholdGroup {
	readonly state: HouseholdGroupState;
	/** Admin: start sharing. The member's own file is untouched - a dedicated
	 *  copy is created and mirrored under a fresh K, and the invitation
	 *  bulletin is published. Refused on a password-protected store: remove
	 *  the password to share, or keep it and do not. */
	startShare(): Promise<{ fileId: string; key: string }>;
	/** Admin: re-show (and refresh) the standing invitation link. Idempotent. */
	invite(): Promise<{ fileId: string; key: string }>;
	/** /share: open an invitation link's bulletin and remember it for the join. */
	openIncoming(fileId: string, key: string): Promise<IncomingShare | null>;
	/** Member: after openIncoming + own store connected, join read-write now.
	 *  Your own file stays yours: a dedicated copy is created and mirrored
	 *  under K, the others' copies attach as keyed peers (the next converge
	 *  folds the shared data into your own file), and my copy is announced.
	 *  Same honest rule as startShare: a password-protected store refuses.
	 *  With a `wallet` getter, one membership per share: joining another share
	 *  ADDS a membership (bound to the attached silo), and a re-join over the
	 *  same silo replaces its stale one. Without the getter, the historical
	 *  single-membership rule holds ('mismatch' on a different share). */
	join(): Promise<'joined' | 'no-invite' | 'mismatch' | 'error'>;
	/** Both: one convergence round (admin folds new announces + rebroadcasts;
	 *  everyone re-arms mirror/peers). Called on every converge. */
	syncGroup(): Promise<void>;
	/** End ONE share on this device - and, for the admin, this is the real
	 *  revocation (bearer link: the lock changes for everyone). The bulletin
	 *  is revoked, my copy file is dropped, mirror and peers detach. The
	 *  member's own file is untouched: everyone keeps what already converged into
	 *  their own file - the local-first reality. Re-sharing mints a fresh K
	 *  and a fresh link for whoever should stay. `walletFileId` names WHICH
	 *  membership; omitted, the primary one (admin first) goes. */
	leave(walletFileId?: string | null): Promise<void>;
	/** On boot: re-arm the mirror and peers of the current share. */
	restore(): Promise<void>;
}

// --- Factory --------------------------------------------------------------------

export function createHouseholdGroup(deps: {
	store: LocalStore;
	kv: KV;
	backend: ShareBackend;
	/** KV key the group record lives under. Default HOUSEHOLD_GROUP_KEY. */
	storageKey?: string;
	/** The currently attached wallet file id, for multi-backup hosts. When
	 *  given, start/join bind the share to that file and the engine goes
	 *  dormant whenever another one is attached. Omit on single-wallet hosts. */
	wallet?: () => Promise<string | null>;
}): HouseholdGroup {
	const { store, kv, backend, wallet } = deps;
	const storageKey = deps.storageKey ?? HOUSEHOLD_GROUP_KEY;

	let groups: StoredGroup[] | null = null;
	let loaded = false;
	// Member roster mirror: how many consecutive fresh reads a known peer has
	// been MISSING from the bulletin. Removals apply only at 2 - a single stale
	// relay read must never cut a still-valid member's data off. Keys are
	// scoped per share (`mailboxId:fileId`).
	const rosterMisses = new Map<string, number>();

	async function load(): Promise<StoredGroup[]> {
		if (!loaded) {
			const raw = await kv.get<StoredGroups | StoredGroup>(storageKey);
			if (!raw) groups = [];
			else if ((raw as StoredGroups).v === 2) groups = (raw as StoredGroups).groups;
			// A pre-multi single record lifts into a one-entry list, verbatim.
			else groups = [raw as StoredGroup];
			loaded = true;
		}
		return groups as StoredGroup[];
	}

	/** Write the current list back (the callers mutate `groups` in place). An
	 *  empty list clears the key: no membership, no record. */
	async function persist(): Promise<void> {
		loaded = true;
		if (!groups || groups.length === 0) {
			groups = groups ?? [];
			await kv.del(storageKey);
			return;
		}
		await kv.set(storageKey, { v: 2, groups } satisfies StoredGroups);
	}

	const adminGroup = (list: StoredGroup[]): StoredGroup | null =>
		list.find((g) => g.role === 'admin') ?? null;
	/** The membership the singular state fields describe: admin first. */
	const primaryGroup = (list: StoredGroup[]): StoredGroup | null =>
		adminGroup(list) ?? list[0] ?? null;
	/** Who shares a joined group with me: the admin's copy leads the roster. */
	const sharedByOf = (g: StoredGroup): string | null =>
		g.role === 'member' ? (g.roster[0]?.ownerEmail ?? g.roster[0]?.ownerName ?? null) : null;

	/** A fresh 32-byte key, base64url, for a new share (the link fragment). */
	function randomKey(): string {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		let s = '';
		for (const b of bytes) s += String.fromCharCode(b);
		return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
	}

	/** The honest rule, enforced at both entrances: sharing never re-keys the
	 *  own file, so a password-protected store cannot publish a readable copy
	 *  without lowering the bar its owner chose. Refuse plainly. */
	function refuseProtected(): void {
		if (store.state.encrypted) {
			throw new Error(
				'household-group: a password-protected store cannot be shared - remove the password first'
			);
		}
	}

	/** Whether the share's bound wallet is the attached one. Unbound (or no
	 *  getter) is always in scope - the single-wallet behavior. */
	async function inScope(group: StoredGroup): Promise<boolean> {
		if (!group.walletFileId || !wallet) return true;
		return (await wallet()) === group.walletFileId;
	}

	/** Out-of-scope dormancy: tear down BOTH directions. The mirror would leak
	 *  the attached silo's data into the copy; the peers would fold the shared
	 *  data into that silo. Nothing else moves until the bound wallet is back. */
	function disarm(group: StoredGroup): void {
		store.detachMirror(mirrorId(group));
		for (const link of group.roster) {
			if (link.fileId !== group.myCopy.fileId) store.detachPeer(link.fileId);
		}
	}

	/** Re-arm my copy's mirror (idempotent - safe on every converge/boot). */
	function ensureMirror(group: StoredGroup): void {
		const id = mirrorId(group);
		if (store.state.mirrors.some((m) => m.id === id)) return;
		store.attachMirror(backend.copyTarget(group.myCopy.fileId), {
			password: group.key,
			id
		});
	}

	/** Attach every roster copy that is not mine and not already attached as a
	 *  read-only peer under K (its own key - the member's file has none). Idempotent. */
	function attachPeers(group: StoredGroup): void {
		const already = new Set(store.state.peers.map((p) => p.id));
		for (const link of group.roster) {
			if (link.fileId === group.myCopy.fileId) continue;
			if (already.has(link.fileId)) continue;
			store.attachPeer(backend.peerSource(link), { id: link.fileId, password: group.key });
		}
	}

	/** Merge new copies into a roster, de-duplicated by fileId, dropping mine. */
	function mergeRoster(roster: CopyLink[], incoming: CopyLink[], selfFileId: string): CopyLink[] {
		const byId = new Map(roster.map((l) => [l.fileId, l]));
		for (const link of incoming) {
			if (link.fileId === selfFileId) continue;
			byId.set(link.fileId, link);
		}
		return [...byId.values()];
	}

	/** Post an announce with small bounded retries; true when one landed. A lost
	 *  announce strands the joiner - visible to nobody, editing into the void -
	 *  so it is worth a few immediate retries before falling back to the
	 *  persistent announcePending re-announce loop. */
	async function announceWithRetry(mailboxId: string, copy: CopyLink): Promise<boolean> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await backend.announce(mailboxId, copy);
				return true;
			} catch {
				if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
			}
		}
		return false;
	}

	/** One admin converge: fold newly-announced member copies, rebroadcast. */
	async function adminRound(group: StoredGroup): Promise<void> {
		const announced = await backend.takeAnnounces(group.mailboxId);
		const roster = mergeRoster(group.roster, announced, group.myCopy.fileId);
		const grew = roster.length !== group.roster.length;
		const needed = group.needsRebroadcast === true;
		group.roster = roster;
		await persist();
		attachPeers(group);
		// Rebroadcast on growth or when a previous rebroadcast failed: keyed
		// on `grew` alone, an offline publish left the bulletin stale forever
		// (the announce was already consumed, so no later round re-grew).
		if ((grew || needed) && group.live === true) {
			try {
				const where = await backend.publishBulletin(group.key, {
					v: 1,
					mailboxId: group.mailboxId,
					roster
				});
				group.bulletin = where;
				group.needsRebroadcast = undefined;
			} catch {
				group.needsRebroadcast = true;
			}
			await persist();
		}
	}

	/** Mirror the authoritative roster onto the local one. Removals apply
	 *  CONSERVATIVELY: a peer drops only after two consecutive fresh reads
	 *  without it (stale relay tolerance). */
	function applyRosterRemovals(group: StoredGroup, byId: Map<string, CopyLink>): void {
		for (const link of group.roster) {
			if (link.fileId === group.myCopy.fileId) continue;
			const missKey = `${group.mailboxId}:${link.fileId}`;
			if (byId.has(link.fileId)) {
				rosterMisses.delete(missKey);
				continue;
			}
			const misses = (rosterMisses.get(missKey) ?? 0) + 1;
			if (misses >= 2) {
				rosterMisses.delete(missKey);
				store.detachPeer(link.fileId);
			} else {
				rosterMisses.set(missKey, misses);
				byId.set(link.fileId, link);
			}
		}
	}

	/** One member converge: reread the bulletin (the admin's roster is
	 *  AUTHORITATIVE - replace, not merge, so removals propagate), self-heal a
	 *  lost announce, track the stale verdict. Pre-multi records carry no
	 *  bulletin: their refresh stays dormant, peers still fold. */
	async function memberRound(group: StoredGroup): Promise<void> {
		const share = group.bulletin
			? await backend.rereadJoined(group.bulletin.fileId, group.bulletin.key)
			: null;
		if (share === 'unreadable') {
			// Fetched but no longer decrypts: the admin rotated the link. Two
			// consecutive verdicts set the stale flag the host must surface -
			// from here my edits publish into a copy nobody folds. Peers keep
			// folding (the member keeps what already converged).
			const n = (group.unreadableReads ?? 0) + 1;
			group.unreadableReads = n;
			if (n >= 2) group.stale = true;
			await persist();
			attachPeers(group);
			return;
		}
		if (!share) {
			// Unreachable bulletin: conclude nothing - but a pending announce
			// still retries (the mailbox may answer even when the bulletin
			// relay does not), so a stranded joiner heals as soon as ANY
			// network path opens, not only after a full bulletin read.
			if (group.announcePending) {
				await backend.announce(group.mailboxId, group.myCopy).catch(() => undefined);
			}
			attachPeers(group);
			return;
		}
		// A readable bulletin is proof the share lives: clear staleness.
		group.unreadableReads = undefined;
		group.stale = undefined;
		const byId = new Map(share.roster.map((l) => [l.fileId, l]));
		// SELF-HEAL: my own copy missing from a fresh roster means my
		// announce was lost. Announce again (with retries); the admin's
		// fold de-dups. announcePending tracks the truth either way, so
		// the host can say "waiting to be seen" instead of false calm.
		if (!byId.has(group.myCopy.fileId)) {
			byId.set(group.myCopy.fileId, group.myCopy);
			group.announcePending = true;
			await announceWithRetry(group.mailboxId, group.myCopy);
		} else {
			group.announcePending = undefined;
		}
		applyRosterRemovals(group, byId);
		group.roster = [...byId.values()];
		await persist();
		attachPeers(group);
	}

	return {
		get state(): HouseholdGroupState {
			const list = groups ?? [];
			const memberships: MembershipInfo[] = list.map((g) => ({
				walletFileId: g.walletFileId ?? null,
				isAdmin: g.role === 'admin',
				selfFileId: g.myCopy.fileId,
				sharedBy: sharedByOf(g),
				memberCount: g.roster.length,
				announcePending: g.announcePending === true,
				stale: g.stale === true
			}));
			const group = primaryGroup(list);
			if (!group) {
				return {
					active: false,
					isAdmin: false,
					memberCount: 0,
					members: [],
					selfFileId: null,
					walletFileId: null,
					inviteCapability: null,
					memberships
				};
			}
			return {
				active: true,
				isAdmin: group.role === 'admin',
				memberCount: group.roster.length,
				members: group.roster.map((l) => ({
					fileId: l.fileId,
					label: l.ownerEmail ?? l.ownerName ?? l.fileId.slice(0, 8)
				})),
				selfFileId: group.myCopy.fileId,
				walletFileId: group.walletFileId ?? null,
				inviteCapability:
					group.role === 'admin' && group.live === true && group.bulletin ? group.bulletin : null,
				memberships
			};
		},

		async startShare(): Promise<{ fileId: string; key: string }> {
			const list = await load();
			// One ADMIN share per device; joined memberships do not block it.
			if (adminGroup(list)) {
				throw new Error('household-group: a share already exists on this device');
			}
			refuseProtected();
			const key = randomKey();
			const mailboxId = randomId();
			const walletFileId = (await wallet?.()) ?? undefined;
			// The copy is a dedicated file - the member's own file is never in the roster.
			const link = await backend.createCopy();
			const roster = [link];
			// Persist before the publish: a failure at any later step leaves a
			// recoverable half-share (restore re-arms the mirror, invite() finishes
			// the publication). Nothing here is irreversible for the member's own file.
			const group: StoredGroup = {
				role: 'admin',
				walletFileId,
				key,
				mailboxId,
				roster,
				myCopy: link,
				live: false
			};
			list.push(group);
			await persist();
			// The mirror fills the copy right away and keeps it fresh after every
			// save/converge that moves data. The member's own file is not touched.
			ensureMirror(group);
			const where = await backend.publishBulletin(key, { v: 1, mailboxId, roster });
			group.bulletin = where;
			group.live = true;
			await persist();
			return where;
		},

		async invite(): Promise<{ fileId: string; key: string }> {
			const group = adminGroup(await load());
			if (!group) {
				throw new Error('household-group: invite() requires an admin share');
			}
			// Refresh the bulletin (fresh projection + current roster) and mark live.
			const where = await backend.publishBulletin(group.key, {
				v: 1,
				mailboxId: group.mailboxId,
				roster: group.roster
			});
			group.bulletin = where;
			group.live = true;
			await persist();
			return where;
		},

		async openIncoming(fileId: string, key: string): Promise<IncomingShare | null> {
			return backend.openIncoming(fileId, key);
		},

		async join(): Promise<'joined' | 'no-invite' | 'mismatch' | 'error'> {
			const list = await load();
			const incoming = await backend.takeStashedIncoming();
			// No invitation opened: a device already holding a membership answers
			// the historical idempotent 'joined'; a bare one names the dead end.
			if (!incoming) return list.length > 0 ? 'joined' : 'no-invite';
			const { key, fileId, content } = incoming;
			if (list.some((g) => g.mailboxId === content.share.mailboxId)) return 'joined';
			// Single-wallet hosts (no getter) keep the one-membership rule: an
			// invitation to ANOTHER share is a dead end, not a silent second join.
			if (!wallet && list.length > 0) return 'mismatch';
			refuseProtected();
			const walletFileId = (await wallet?.()) ?? undefined;
			// A re-join over the same silo replaces its stale membership (a rotated
			// link): two shares must never publish the same wallet.
			if (walletFileId) {
				const stale = list.find((g) => g.walletFileId === walletFileId);
				if (stale) {
					disarm(stale);
					await backend.dropCopy(stale.myCopy.fileId).catch(() => undefined);
					groups = list.filter((g) => g !== stale);
				}
			}
			// My copy is a dedicated file; my own store stays mine. The shared
			// data arrives by folding the others' copies into it on the next
			// converge - one store per person, converging.
			const link = await backend.createCopy(undefined, content.share.roster[0]?.ownerEmail);
			const roster = mergeRoster(content.share.roster, [link], '');
			const group: StoredGroup = {
				role: 'member',
				walletFileId,
				key,
				mailboxId: content.share.mailboxId,
				roster,
				myCopy: link,
				// The invitation capability, kept so THIS membership rereads ITS
				// bulletin on converge (roster removals, lost-announce self-heal).
				bulletin: { fileId, key }
			};
			(groups as StoredGroup[]).push(group);
			await persist();
			ensureMirror(group);
			attachPeers(group);
			// Announce my copy so the admin folds it into everyone's roster. NOT
			// best-effort-and-forget: a swallowed failure here once stranded a
			// joiner for good - member on their side, visible to nobody, editing
			// into the void. Retry now; still failing, persist announcePending so
			// every converge keeps announcing until a fresh roster carries me.
			if (!(await announceWithRetry(content.share.mailboxId, link))) {
				group.announcePending = true;
				await persist();
			}
			return 'joined';
		},

		async syncGroup(): Promise<void> {
			const list = await load();
			for (const group of list) {
				// Defense in depth for the honest rule: a store that became
				// password-protected (or joined from a device whose store turned out
				// protected) must never publish a link-readable copy. Tear the mirror
				// down if one was armed; the share lies dormant on this device until
				// the password is removed. (Folding INBOUND peers would be harmless,
				// but a dormant share should read as dormant - arm nothing.)
				if (store.state.encrypted) {
					store.detachMirror(mirrorId(group));
					continue;
				}
				// Another silo is attached: full dormancy, both directions (see disarm).
				if (!(await inScope(group))) {
					disarm(group);
					continue;
				}
				ensureMirror(group);
				if (group.role === 'admin') await adminRound(group);
				else await memberRound(group);
			}
		},

		async leave(walletFileId?: string | null): Promise<void> {
			const list = await load();
			const group =
				walletFileId != null
					? (list.find((g) => g.walletFileId === walletFileId) ?? null)
					: primaryGroup(list);
			if (!group) return;
			// Detach the plumbing first: nothing publishes or folds anymore.
			disarm(group);
			if (group.role === 'admin') {
				try {
					await backend.revokeBulletin();
				} catch {
					/* tolerable: the bulletin only ever holds K-encrypted data */
				}
			}
			// My copy file dies with the membership (private first, then gone).
			// The member's own file is untouched: it never carried the share key, and the
			// data already converged into it stays - local-first honesty.
			await backend.dropCopy(group.myCopy.fileId).catch(() => undefined);
			groups = list.filter((g) => g !== group);
			for (const k of [...rosterMisses.keys()]) {
				if (k.startsWith(`${group.mailboxId}:`)) rosterMisses.delete(k);
			}
			await persist();
		},

		async restore(): Promise<void> {
			const list = await load();
			// Same dormancy rules as syncGroup: a protected store never mirrors,
			// and a share bound to another silo arms nothing while it is away.
			if (store.state.encrypted) return;
			for (const group of list) {
				if (!(await inScope(group))) continue;
				ensureMirror(group);
				attachPeers(group);
			}
		}
	};
}
