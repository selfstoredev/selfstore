// shareFlow: the "who can see this" panel as a headless machine over an
// injected ShareEngine - how links travel (Drive public link, relay,
// mailbox) is the app's business. The flow owns what every such panel gets
// wrong first: a transient listing failure never blanks it (last-known
// links stay, flagged stale - a member who saw an empty panel once will
// revoke something in panic); one operation at a time, so a double-click
// cannot create two links; removals leave the snapshot only after the
// engine confirmed them, never optimistically; removing yourself is refused
// up front (leaving is its own journey, not a row action). Every leg runs
// under a deadline and reports the stable { code, labelKey, message } shape.

import type { StoreError } from '../persistence/store';
import { makeMachine, toStoreError, withDeadline, type FlowStore } from './machine';

export type ShareLevel = 'read' | 'write';

export interface ShareLinkInfo {
	/** Engine-scoped stable id (revoke keys on it). */
	id: string;
	/** The invitation URL to hand out. */
	url: string;
	level: ShareLevel;
}

export interface ShareMemberInfo {
	/** Engine-scoped stable id (removeMember keys on it). */
	id: string;
	label?: string;
	/** This row is the local user. */
	self?: boolean;
	/** This row owns the share (the app may render a badge, the flow does not care). */
	owner?: boolean;
}

/** The app-side port the flow drives. Implementations wrap whatever transport
 *  the app shares through; every method may throw (SelfstoreError preferred,
 *  anything is normalized). */
export interface ShareEngine {
	/** The current truth: active links and members. */
	list(): Promise<{ links: ShareLinkInfo[]; members: ShareMemberInfo[] }>;
	createLink(opts: { level: ShareLevel }): Promise<ShareLinkInfo>;
	revokeLink(id: string): Promise<void>;
	/** Optional: engines without member management simply omit it. */
	removeMember?(id: string): Promise<void>;
	/** Optional: END the whole share in one gesture - every link dead, every
	 *  member out. Engines whose transport has such a move (an invitation to
	 *  kill, a file to re-privatize) expose it; the widget renders the action
	 *  only then. */
	revokeAll?(): Promise<void>;
}

export type ShareBusy = 'refresh' | 'create' | 'revoke' | 'remove' | 'revoke-all' | null;

export interface ShareSnapshot {
	links: readonly ShareLinkInfo[];
	members: readonly ShareMemberInfo[];
	/** The operation in flight, or null. */
	busy: ShareBusy;
	/** The last refresh failed: the lists shown are the last-known good ones. */
	stale: boolean;
	/** The last operation's problem (the lists are never cleared by an error). */
	error: StoreError | null;
	/** True once the engine offers removeMember (render the row action at all). */
	canRemoveMembers: boolean;
	/** True once the engine offers revokeAll (render the end-the-share action). */
	canRevokeAll: boolean;
}

export interface ShareFlow extends FlowStore<ShareSnapshot> {
	/** Re-list from the engine. Failure keeps the last-known lists (stale). */
	refresh(): Promise<void>;
	/** Create an invitation link. Resolves to it, or null when refused (an
	 *  operation was already in flight). */
	createLink(opts: { level: ShareLevel }): Promise<ShareLinkInfo | null>;
	/** Revoke a link. The link leaves the snapshot only once the engine
	 *  confirmed. Resolves to whether it did. */
	revokeLink(id: string): Promise<boolean>;
	/** Remove a member (never yourself - refused up front). Resolves to whether
	 *  the engine confirmed. */
	removeMember(id: string): Promise<boolean>;
	/** End the whole share: every link and member leaves the snapshot only
	 *  once the engine confirmed. Resolves to whether it did. */
	revokeAll(): Promise<boolean>;
}

const DEFAULT_DEADLINE_MS = 30_000;

export function shareFlow(engine: ShareEngine, options: { deadlineMs?: number } = {}): ShareFlow {
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

	const m = makeMachine<ShareSnapshot>({
		links: [],
		members: [],
		busy: 'refresh',
		stale: false,
		error: null,
		canRemoveMembers: typeof engine.removeMember === 'function',
		canRevokeAll: typeof engine.revokeAll === 'function'
	});

	/** Serialize the operations: one at a time, the others answer "refused". */
	function begin(op: Exclude<ShareBusy, null>): boolean {
		if (m.snapshot.busy !== null && !(op === 'refresh' && m.snapshot.busy === 'refresh')) {
			return false;
		}
		m.set({ busy: op });
		return true;
	}

	async function doRefresh(): Promise<void> {
		try {
			const { links, members } = await withDeadline(engine.list(), deadlineMs, 'The share listing');
			m.set({ links, members, busy: null, stale: false, error: null });
		} catch (e) {
			// Keep the last-known lists: a hiccup must never paint the share as
			// gone. Just say the view may be behind.
			m.set({ busy: null, stale: true, error: toStoreError(e) });
		}
	}

	const flow: ShareFlow = {
		get snapshot() {
			return m.snapshot;
		},
		subscribe: m.subscribe,

		async refresh(): Promise<void> {
			if (m.snapshot.busy !== null && m.snapshot.busy !== 'refresh') return;
			m.set({ busy: 'refresh' });
			await doRefresh();
		},

		async createLink(opts): Promise<ShareLinkInfo | null> {
			if (!begin('create')) return null;
			try {
				const link = await withDeadline(engine.createLink(opts), deadlineMs, 'Creating the link');
				m.set({ links: [...m.snapshot.links, link], busy: null, error: null });
				return link;
			} catch (e) {
				m.set({ busy: null, error: toStoreError(e) });
				return null;
			}
		},

		async revokeLink(id: string): Promise<boolean> {
			if (!begin('revoke')) return false;
			try {
				await withDeadline(engine.revokeLink(id), deadlineMs, 'Revoking the link');
				// Confirmed: NOW it leaves the snapshot.
				m.set({ links: m.snapshot.links.filter((l) => l.id !== id), busy: null, error: null });
				return true;
			} catch (e) {
				m.set({ busy: null, error: toStoreError(e) });
				return false;
			}
		},

		async removeMember(id: string): Promise<boolean> {
			const remove = engine.removeMember?.bind(engine);
			if (!remove) {
				throw new TypeError('shareFlow: this engine does not manage members (no removeMember).');
			}
			const row = m.snapshot.members.find((mb) => mb.id === id);
			if (row?.self) {
				throw new TypeError(
					'shareFlow: refusing to remove yourself - leaving a share is its own journey, not a row action.'
				);
			}
			if (!begin('remove')) return false;
			try {
				await withDeadline(remove(id), deadlineMs, 'Removing the member');
				m.set({
					members: m.snapshot.members.filter((mb) => mb.id !== id),
					busy: null,
					error: null
				});
				return true;
			} catch (e) {
				m.set({ busy: null, error: toStoreError(e) });
				return false;
			}
		},

		async revokeAll(): Promise<boolean> {
			const revoke = engine.revokeAll?.bind(engine);
			if (!revoke) {
				throw new TypeError('shareFlow: this engine does not end the share (no revokeAll).');
			}
			if (!begin('revoke-all')) return false;
			try {
				await withDeadline(revoke(), deadlineMs, 'Ending the share');
				// Confirmed: the share is over, every link and member with it.
				m.set({ links: [], members: [], busy: null, error: null });
				return true;
			} catch (e) {
				m.set({ busy: null, error: toStoreError(e) });
				return false;
			}
		}
	};

	// The panel opens on the truth: list right away (failures land as stale).
	void doRefresh();

	return flow;
}
