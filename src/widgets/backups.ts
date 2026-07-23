// <selfstore-backups>: the backups lists over the headless BackupsManager.
// Two sections. "My backups": every file this account owns, the attached one
// included (badge + outline, never clickable); tapping another row opens it,
// collecting its passphrase inline when protected; each row carries state
// pills (omitted while unknown, never guessed) and an overflow menu. "Shared
// with me": files someone else shares with this device, labelled by who -
// removal is the only gesture, and for the member row it means leaving,
// which the host performs ('selfstore-backups-leave').
//
// The status card, the unlock gate and the encrypt/share sub-views stay the
// host's - they carry app identity, passkeys, sharing transport. Encrypt and
// Share menu items only emit; the host opens its own surface. Destructive
// gestures route through confirmAction (window.confirm fits as-is). The
// with-* attributes turn sections and menu items off; labels localize.

import type { BackupRow, BackupsManager } from '../backups/manager';
import type { ConnectKind } from '../flows/connect';
import type { ReplicaFlow, ReplicaSnapshot } from '../flows/replica';
import type { WebdavConfig } from '../persistence/targets/webdav';
import type { S3Config } from '../persistence/targets/s3';
import { FlowWidget, h, put, type WidgetLabels } from './base';

const EN: WidgetLabels = {
	'backups.mine.heading': 'My backups',
	'backups.mine.personal': 'Main backup',
	'backups.active': 'Active',
	'backups.pill.encrypted': 'Encrypted',
	'backups.pill.plain': 'Not encrypted',
	'backups.pill.shared': 'Shared',
	'backups.pill.private': 'Not shared',
	'backups.modified': 'modified {when}',
	'backups.replaceHint': 'Opening replaces the data on this device.',
	'backups.loading': 'Opening...',
	'backups.menu': 'Backup actions',
	'backups.open': 'Open',
	'backups.encrypt': 'Encrypt',
	'backups.share': 'Share',
	'backups.rename': 'Rename',
	'backups.delete': 'Delete',
	'backups.new': '+ New backup',
	'backups.newTitle': 'New backup',
	'backups.startsBlank': 'It starts empty.',
	'backups.namePh': 'Its name',
	'backups.willBe': 'File: {file}',
	'backups.taken': 'This name is already taken.',
	'backups.create': 'Create',
	'backups.renameTitle': 'Rename this backup',
	'backups.pwHint': 'This backup is protected: enter its password.',
	'backups.pwShow': 'Show the password',
	'backups.pwHide': 'Hide the password',
	'backups.cancel': 'Cancel',
	'backups.shared.heading': 'Shared with me',
	'backups.shared.by': 'Shared by {who}',
	'backups.shared.leave': 'Leave',
	'backups.replica.add': 'Backup copy',
	'backups.replica.title': 'Backup copy',
	'backups.replica.intro':
		'The same encrypted file, also written to a second destination. If one fails, the other remains.',
	'backups.replica.dest.drive': 'Google Drive',
	'backups.replica.dest.file': 'A file on this device',
	'backups.replica.dest.webdav': 'A WebDAV server',
	'backups.replica.dest.s3': 'An S3 bucket',
	'backups.replica.card': 'Backup copy - {label}',
	'backups.replica.uptodate': 'Up to date, {when}',
	'backups.replica.pending': 'First copy at the next save',
	'backups.replica.error': 'Unreachable - will retry at the next save',
	'backups.replica.remove': 'Remove',
	'backups.replica.save': 'Add the copy',
	'backups.replica.webdav.url': 'File URL on the server (https://host:8443/dav/file.zip)',
	'backups.replica.webdav.help':
		'The full URL of the backup file, including a custom port if any. The server must allow this app to reach it (CORS) - some hosted drives do not, and will not connect from a browser.',
	'backups.replica.webdav.user': 'Username',
	'backups.replica.webdav.password': 'Password',
	'backups.replica.s3.endpoint': 'Endpoint URL',
	'backups.replica.s3.region': 'Region',
	'backups.replica.s3.bucket': 'Bucket',
	'backups.replica.s3.key': 'Object key (file name)',
	'backups.replica.s3.accessKeyId': 'Access key ID',
	'backups.replica.s3.secret': 'Secret access key',
	'error.generic': 'That did not work. Check the connection and try again.'
};

/** A destructive gesture, offered to confirmAction before it runs. `delete`
 *  and `forget` carry the row; `leave` is a membership's removal (fileId =
 *  its wallet, null for a legacy unbound one) - the host performs the actual
 *  leave on the 'selfstore-backups-leave' event, whose detail repeats it. */
export type BackupsAction =
	| { type: 'delete'; fileId: string; name: string; active: boolean }
	| { type: 'forget'; fileId: string; who: string }
	| { type: 'leave'; fileId: string | null; who: string }
	| { type: 'replica-remove'; label: string };

/** "off"-style attribute values; anything else (including empty) reads as on. */
const isOff = (v: string | null): boolean =>
	v != null && ['off', 'false', 'no', '0'].includes(v.trim().toLowerCase());

const EYE_OPEN =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.4 4.4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.4-1.4"/></svg>';

export class SelfstoreBackupsElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return [
			'with-create',
			'with-rename',
			'with-delete',
			'with-open',
			'with-encrypt',
			'with-share',
			'with-shared'
		];
	}

	#manager: BackupsManager | null = null;
	#rows: BackupRow[] | null = null;
	#lastActive: string | null | undefined = undefined;
	#listing = false;
	#busy = false;
	#openBusy: string | null = null;
	#menuFor: string | null = null;
	#pwFor: string | null = null;
	#pw = '';
	#pwShown = false;
	#renameFor: BackupRow | null = null;
	#renameLabel = '';
	#createOpen = false;
	#createLabel = '';
	#members: { by: string; fileId?: string | null }[] = [];
	#replicaFlow: ReplicaFlow | null = null;
	#replicaSnap: ReplicaSnapshot | null = null;
	#repWebdav: WebdavConfig = { url: '', username: '', password: '' };
	#repS3: S3Config = {
		endpoint: '',
		region: '',
		bucket: '',
		key: '',
		accessKeyId: '',
		secretAccessKey: ''
	};
	#activeEncrypted: boolean | null = null;
	#activeShared: boolean | null = null;
	#confirmAction: ((action: BackupsAction) => boolean | Promise<boolean>) | null = null;
	#withCreate = true;
	#withRename = true;
	#withDelete = true;
	#withOpen = true;
	#withEncrypt = true;
	#withShare = true;
	#withShared = true;

	protected defaults(): WidgetLabels {
		return EN;
	}

	/** The headless manager this panel drives (see 'selfstore/backups'). */
	get manager(): BackupsManager | null {
		return this.#manager;
	}
	set manager(v: BackupsManager | null) {
		this.#manager = v;
		this.wire();
	}

	/** The households this device is a member of (one entry per share, or a
	 *  single object for one): each renders in "Shared with me" labeled by who
	 *  shares it, removal = leaving (host performs it on
	 *  'selfstore-backups-leave', whose detail names the entry's fileId). With
	 *  `fileId` (the share's dedicated wallet), that registry row IS the
	 *  member row: active it wears the badge, inactive it opens like any
	 *  shared silo - and its one menu action is leaving, never a mere forget. */
	get member(): { by: string; fileId?: string | null }[] | null {
		return this.#members.length > 0 ? this.#members : null;
	}
	set member(
		v: { by: string; fileId?: string | null }[] | { by: string; fileId?: string | null } | null
	) {
		this.#members = v == null ? [] : Array.isArray(v) ? v : [v];
		this.rerender();
	}

	/** Live state of the ATTACHED backup, from the host's store: the active
	 *  row's pills prefer these over the learned memories (which may lag). */
	get activeEncrypted(): boolean | null {
		return this.#activeEncrypted;
	}
	set activeEncrypted(v: boolean | null) {
		this.#activeEncrypted = v;
		this.rerender();
	}
	get activeShared(): boolean | null {
		return this.#activeShared;
	}
	set activeShared(v: boolean | null) {
		this.#activeShared = v;
		this.rerender();
	}

	/** Host veto over the destructive gestures (delete / forget / leave):
	 *  answer (or resolve) false to keep things as they are - window.confirm
	 *  fits as-is. Default: everything proceeds. */
	get confirmAction(): ((action: BackupsAction) => boolean | Promise<boolean>) | null {
		return this.#confirmAction;
	}
	set confirmAction(v: ((action: BackupsAction) => boolean | Promise<boolean>) | null) {
		this.#confirmAction = v ?? null;
	}

	get withCreate(): boolean {
		return this.#withCreate;
	}
	set withCreate(v: boolean) {
		this.#withCreate = v !== false;
		this.rerender();
	}
	get withRename(): boolean {
		return this.#withRename;
	}
	set withRename(v: boolean) {
		this.#withRename = v !== false;
		this.rerender();
	}
	get withDelete(): boolean {
		return this.#withDelete;
	}
	set withDelete(v: boolean) {
		this.#withDelete = v !== false;
		this.rerender();
	}
	get withOpen(): boolean {
		return this.#withOpen;
	}
	set withOpen(v: boolean) {
		this.#withOpen = v !== false;
		this.rerender();
	}
	get withEncrypt(): boolean {
		return this.#withEncrypt;
	}
	set withEncrypt(v: boolean) {
		this.#withEncrypt = v !== false;
		this.rerender();
	}
	get withShare(): boolean {
		return this.#withShare;
	}
	set withShare(v: boolean) {
		this.#withShare = v !== false;
		this.rerender();
	}
	get withShared(): boolean {
		return this.#withShared;
	}
	set withShared(v: boolean) {
		this.#withShared = v !== false;
		this.rerender();
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		const on = value == null || !isOff(value);
		if (name === 'with-create') this.withCreate = on;
		if (name === 'with-rename') this.withRename = on;
		if (name === 'with-delete') this.withDelete = on;
		if (name === 'with-open') this.withOpen = on;
		if (name === 'with-encrypt') this.withEncrypt = on;
		if (name === 'with-share') this.withShare = on;
		if (name === 'with-shared') this.withShared = on;
	}

	connectedCallback(): void {
		this.wire();
	}

	/** Re-list the rows from the destination (the host calls this after a
	 *  gesture of its own moved things - a leave, an external change). */
	refresh(): void {
		void this.loadRows();
	}

	private wire(): void {
		if (!this.isConnected || !this.#manager) return;
		this.unsub?.();
		const manager = this.#manager;
		const unsubManager = manager.subscribe((snap) => {
			// A switch (or first attach) re-lists; every snapshot repaints.
			if (snap.activeFileId !== this.#lastActive) {
				this.#lastActive = snap.activeFileId;
				void this.loadRows();
			}
			this.rerender();
		});
		const unsubReplica = this.#replicaFlow?.subscribe((snap) => {
			this.#replicaSnap = snap;
			this.rerender();
		});
		this.unsub = () => {
			unsubManager();
			unsubReplica?.();
		};
		void manager.hydrate().then(() => this.loadRows());
	}

	/** The backup-copy journey (see 'selfstore/flows' replicaFlow). Setting it
	 *  adds a menu entry on the active backup's card and renders the copy
	 *  cards under it; without it the panel is byte-identical to before. The
	 *  widget restores a recorded copy by itself. */
	get replica(): ReplicaFlow | null {
		return this.#replicaFlow;
	}
	set replica(v: ReplicaFlow | null) {
		this.#replicaFlow = v;
		this.#replicaSnap = v?.snapshot ?? null;
		if (v) void v.restore();
		this.wire();
	}

	/** One destination listing, then the lazy encryption probes (each learned
	 *  bit repaints its row). A transient failure keeps the last good list. */
	private async loadRows(): Promise<void> {
		const manager = this.#manager;
		if (!manager || this.#listing) return;
		this.#listing = true;
		try {
			this.#rows = await manager.list();
			this.rerender();
			for (const r of this.#rows ?? []) {
				if (r.encrypted !== null) continue;
				const enc = await manager.probeEncryption(r.fileId);
				if (enc === null || this.#rows === null) continue;
				this.#rows = this.#rows.map((x) => (x.fileId === r.fileId ? { ...x, encrypted: enc } : x));
				this.rerender();
			}
		} catch {
			this.#rows = this.#rows ?? [];
			this.rerender();
		} finally {
			this.#listing = false;
		}
	}

	/** t() with {placeholders}. */
	private ts(key: string, params: Record<string, string>): string {
		return this.t(key).replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? '');
	}

	private label(row: BackupRow): string {
		return row.label ?? this.t('backups.mine.personal');
	}

	protected view(into: HTMLElement): void {
		const manager = this.#manager;
		if (!manager) return;
		const snap = manager.snapshot;
		const rows = this.#rows ?? [];
		const active = snap.activeFileId;

		// --- My backups -----------------------------------------------------
		const mine = snap.joined ? rows.filter((r) => r.fileId !== active) : rows;
		if (this.#rows !== null) put(into, this.heading('sub heading', 'backups.mine.heading'));
		const list = h('ul', { part: 'list' });
		for (const r of mine) {
			const isActive = r.fileId === active;
			if (this.#pwFor === r.fileId) list.append(this.passwordCard(r));
			else if (this.#renameFor?.fileId === r.fileId) list.append(this.renameCard(r));
			// The attached copy is not a backup of its own: it rides INSIDE the
			// active card as one line under its pills (never a card of its own,
			// never for a joined member's shared file).
			else list.append(this.rowCard(r, isActive, isActive ? this.replicaAttachedLine() : null));
			// The destination choice / config form (transient setup) renders as a
			// card right under the active one.
			if (isActive) for (const el of this.replicaSetup()) list.append(el);
		}
		if (list.childElementCount > 0) into.append(list);

		// --- Create ---------------------------------------------------------
		if (this.#withCreate) {
			if (this.#createOpen) into.append(this.createCard());
			else {
				into.append(
					h(
						'button',
						{
							part: 'button new-button',
							'data-action': 'new',
							disabled: this.#busy,
							onclick: () => {
								this.#createOpen = true;
								this.#createLabel = '';
								this.rerender();
							}
						},
						this.t('backups.new')
					)
				);
			}
		}

		// --- Shared with me -------------------------------------------------
		if (!this.#withShared) return;
		const members = this.#members;
		// The badge row: the membership riding the ATTACHED file - wallet-bound
		// when its silo is active (the others' registry rows stand in), or a
		// legacy unbound one on whatever file is attached.
		const badge = members.find((m) => (m.fileId != null ? m.fileId === active : true)) ?? null;
		// An owner already present as a MEMBERSHIP owns its row, and its one
		// action is Leave. A registry entry for that same owner is a stale
		// duplicate of the same share (a re-join left the old file behind): never
		// show it as a second, Forget-only row. Forget rows also collapse to one
		// per owner - never the same email twice.
		const memberWhos = new Set(members.map((m) => m.by));
		const others: { fileId: string; who: string; member: boolean }[] = [];
		const seenForget = new Set<string>();
		for (const s of snap.registry.shared) {
			if (s.fileId === active && !snap.joined) continue;
			const member = members.some((m) => m.fileId === s.fileId);
			const who = s.ownerEmail ?? s.ownerName ?? '?';
			if (!member) {
				if (memberWhos.has(who) || seenForget.has(who)) continue;
				seenForget.add(who);
			}
			others.push({ fileId: s.fileId, who, member });
		}
		if (members.length === 0 && others.length === 0) return;
		put(into, this.heading('sub heading', 'backups.shared.heading'));
		const shared = h('ul', { part: 'list' });
		if (badge) {
			const activeRow = rows.find((r) => r.fileId === active) ?? null;
			const leaveAction: BackupsAction = {
				type: 'leave',
				fileId: badge.fileId ?? null,
				who: badge.by
			};
			shared.append(
				h(
					'li',
					{
						part: 'card card-active',
						style: 'position:relative;border-color:var(--_ok)',
						'data-member': ''
					},
					h(
						'div',
						{ style: 'flex:1;min-width:0' },
						h(
							'div',
							{ part: 'title' },
							badge.fileId != null || !activeRow
								? this.ts('backups.shared.by', { who: badge.by })
								: this.label(activeRow),
							h('span', { part: 'tag' }, this.t('backups.active'))
						),
						badge.fileId == null && activeRow
							? h('div', { part: 'sub' }, this.ts('backups.shared.by', { who: badge.by }))
							: null
					),
					this.menuButton('member'),
					this.#menuFor === 'member'
						? this.menu(
								this.#withDelete
									? this.menuItem('leave', this.t('backups.shared.leave'), true, () =>
											this.guarded(leaveAction, () =>
												this.emit('selfstore-backups-leave', { fileId: leaveAction.fileId })
											)
										)
									: null
							)
						: null
				)
			);
		}
		for (const s of others) {
			// The badge row's file never doubles as a registry row.
			if (badge && s.fileId === active) continue;
			const memberEntry = s.member;
			shared.append(
				h(
					'li',
					{ part: 'card', style: 'position:relative', 'data-shared': s.fileId },
					this.#withOpen
						? h(
								'button',
								{
									part: 'link open-shared',
									style: 'flex:1;min-width:0;text-align:left;text-decoration:none',
									'data-action': 'open-shared',
									disabled: this.#busy,
									onclick: () => this.open(s.fileId)
								},
								h('div', { part: 'title' }, this.ts('backups.shared.by', { who: s.who })),
								h(
									'div',
									{ part: 'sub' },
									this.#openBusy === s.fileId
										? this.t('backups.loading')
										: this.t('backups.replaceHint')
								)
							)
						: h(
								'div',
								{ style: 'flex:1;min-width:0' },
								h('div', { part: 'title' }, this.ts('backups.shared.by', { who: s.who })),
								h('div', { part: 'sub' }, this.t('backups.replaceHint'))
							),
					this.menuButton(s.fileId),
					this.#menuFor === s.fileId
						? this.menu(
								this.#withDelete
									? memberEntry
										? this.menuItem('leave', this.t('backups.shared.leave'), true, () =>
												this.guarded({ type: 'leave', fileId: s.fileId, who: s.who }, () =>
													this.emit('selfstore-backups-leave', { fileId: s.fileId })
												)
											)
										: this.menuItem('forget', this.t('backups.delete'), true, () =>
												this.guarded(
													{ type: 'forget', fileId: s.fileId, who: s.who },
													() => void this.forget(s.fileId)
												)
											)
									: null
							)
						: null
				)
			);
		}
		if (shared.childElementCount > 0) into.append(shared);
	}

	// --- Cards ----------------------------------------------------------------

	private pills(r: BackupRow, active: boolean): (HTMLElement | string | null)[] {
		const enc = active && this.#activeEncrypted !== null ? this.#activeEncrypted : r.encrypted;
		const shr = active && this.#activeShared !== null ? this.#activeShared : r.shared;
		const bits: (HTMLElement | string | null)[] = [];
		if (enc !== null) {
			bits.push(
				h(
					'span',
					{ part: enc ? 'pill pill-encrypted sev-ok' : 'pill pill-plain', style: pillStyle },
					this.t(enc ? 'backups.pill.encrypted' : 'backups.pill.plain')
				)
			);
		}
		if (shr !== null) {
			bits.push(
				h(
					'span',
					{ part: shr ? 'pill pill-shared sev-warn' : 'pill pill-private', style: pillStyle },
					this.t(shr ? 'backups.pill.shared' : 'backups.pill.private')
				)
			);
		}
		if (r.modifiedAt) {
			bits.push(
				h(
					'span',
					{ part: 'sub' },
					this.ts('backups.modified', { when: new Date(r.modifiedAt).toLocaleDateString() })
				)
			);
		}
		return bits;
	}

	private rowCard(r: BackupRow, active: boolean, footer: HTMLElement | null = null): HTMLElement {
		const body = h(
			'div',
			{ style: 'flex:1;min-width:0' },
			h(
				'div',
				{ part: 'title' },
				this.label(r),
				active ? h('span', { part: 'tag' }, this.t('backups.active')) : null
			),
			h('div', { part: 'row', style: 'margin-top:0.2rem' }, ...this.pills(r, active)),
			footer
		);
		const opens = this.#withOpen && !active;
		const face = opens
			? h(
					'button',
					{
						part: 'link open-row',
						style: 'flex:1;min-width:0;text-align:left;text-decoration:none',
						'data-action': 'open',
						disabled: this.#busy,
						onclick: () => this.open(r.fileId)
					},
					this.#openBusy === r.fileId ? h('div', { part: 'sub' }, this.t('backups.loading')) : body
				)
			: body;
		return h(
			'li',
			{
				part: active ? 'card card-active' : 'card',
				style: active ? 'position:relative;border-color:var(--_ok)' : 'position:relative',
				'data-row': r.fileId
			},
			face,
			this.menuButton(r.fileId),
			this.#menuFor === r.fileId
				? this.menu(
						opens
							? this.menuItem('open', this.t('backups.open'), false, () => this.open(r.fileId))
							: null,
						this.#withEncrypt
							? this.menuItem('encrypt', this.t('backups.encrypt'), false, () =>
									this.emit('selfstore-backups-encrypt', {
										fileId: r.fileId,
										label: r.label,
										active
									})
								)
							: null,
						this.#withShare
							? this.menuItem('share', this.t('backups.share'), false, () =>
									this.emit('selfstore-backups-share', { fileId: r.fileId, label: r.label, active })
								)
							: null,
						active &&
							this.#replicaFlow &&
							this.#replicaSnap?.step === 'idle' &&
							!this.#replicaSnap.replica
							? this.menuItem('replica-add', this.t('backups.replica.add'), false, () =>
									this.#replicaFlow?.open()
								)
							: null,
						this.#withRename
							? this.menuItem('rename', this.t('backups.rename'), false, () => {
									this.#renameFor = r;
									this.#renameLabel = r.label ?? '';
									this.rerender();
								})
							: null,
						this.#withDelete
							? this.menuItem('delete', this.t('backups.delete'), true, () =>
									this.guarded(
										{ type: 'delete', fileId: r.fileId, name: r.name, active },
										() => void this.deleteRow(r.fileId)
									)
								)
							: null
					)
				: null
		);
	}

	private passwordCard(r: BackupRow): HTMLElement {
		const submit = (): void => {
			if (this.#pw.length > 0) void this.open(r.fileId, this.#pw);
		};
		return h(
			'li',
			{ part: 'card', 'data-password': r.fileId },
			h(
				'div',
				{ style: 'flex:1;min-width:0' },
				h('div', { part: 'title' }, this.label(r)),
				h('div', { part: 'sub' }, this.t('backups.pwHint')),
				h(
					'div',
					{ part: 'row', style: 'margin-top:0.45rem' },
					h(
						'span',
						{ part: 'field', style: 'flex:1;min-width:9rem' },
						h('input', {
							part: 'input',
							type: this.#pwShown ? 'text' : 'password',
							autocomplete: 'current-password',
							'data-keep': 'backup-pw',
							disabled: this.#busy,
							oninput: (e: Event) => (this.#pw = (e.target as HTMLInputElement).value),
							onkeydown: (e: Event) => {
								if ((e as KeyboardEvent).key === 'Enter') submit();
							}
						}),
						this.eye()
					),
					h(
						'button',
						{
							part: 'button button-primary',
							'data-action': 'pw-open',
							disabled: this.#busy,
							onclick: submit
						},
						this.t('backups.open')
					),
					h(
						'button',
						{
							part: 'button',
							'data-action': 'pw-cancel',
							disabled: this.#busy,
							onclick: () => this.closePw()
						},
						this.t('backups.cancel')
					)
				)
			)
		);
	}

	private renameCard(r: BackupRow): HTMLElement {
		const taken = this.nameTaken(this.#renameLabel, r.fileId);
		const clean = this.#renameLabel.trim();
		return h(
			'li',
			{ part: 'card', 'data-rename': r.fileId },
			h(
				'div',
				{ style: 'flex:1;min-width:0' },
				h('div', { part: 'title' }, this.t('backups.renameTitle')),
				h('input', {
					part: 'input',
					style: 'margin-top:0.45rem',
					'data-keep': 'rename-label',
					maxlength: '40',
					disabled: this.#busy,
					value: this.#renameLabel,
					oninput: (e: Event) => {
						this.#renameLabel = (e.target as HTMLInputElement).value;
						this.rerender();
					}
				}),
				taken
					? h('div', { part: 'error-note' }, this.t('backups.taken'))
					: clean
						? h(
								'div',
								{ part: 'sub' },
								this.ts('backups.willBe', { file: this.#manager?.fileNameFor(clean) ?? '' })
							)
						: null,
				h(
					'div',
					{ part: 'row', style: 'margin-top:0.45rem' },
					h(
						'button',
						{
							part: 'button button-primary',
							'data-action': 'rename-save',
							disabled: this.#busy || !clean || taken,
							onclick: () => void this.rename(r)
						},
						this.t('backups.rename')
					),
					h(
						'button',
						{
							part: 'button',
							'data-action': 'rename-cancel',
							disabled: this.#busy,
							onclick: () => {
								this.#renameFor = null;
								this.rerender();
							}
						},
						this.t('backups.cancel')
					)
				)
			)
		);
	}

	private createCard(): HTMLElement {
		const taken = this.nameTaken(this.#createLabel, null);
		const clean = this.#createLabel.trim();
		return h(
			'div',
			{ part: 'card', 'data-create': '' },
			h(
				'div',
				{ style: 'flex:1;min-width:0' },
				h('div', { part: 'title' }, this.t('backups.newTitle')),
				h('div', { part: 'sub' }, this.t('backups.startsBlank')),
				h('input', {
					part: 'input',
					style: 'margin-top:0.45rem',
					placeholder: this.t('backups.namePh'),
					'data-keep': 'create-label',
					maxlength: '40',
					disabled: this.#busy,
					oninput: (e: Event) => {
						this.#createLabel = (e.target as HTMLInputElement).value;
						this.rerender();
					}
				}),
				taken
					? h('div', { part: 'error-note' }, this.t('backups.taken'))
					: clean
						? h(
								'div',
								{ part: 'sub' },
								this.ts('backups.willBe', { file: this.#manager?.fileNameFor(clean) ?? '' })
							)
						: null,
				h(
					'div',
					{ part: 'row', style: 'margin-top:0.45rem' },
					h(
						'button',
						{
							part: 'button button-primary',
							'data-action': 'create',
							disabled: this.#busy || !clean || taken,
							onclick: () => void this.create()
						},
						this.t('backups.create')
					),
					h(
						'button',
						{
							part: 'button',
							'data-action': 'create-cancel',
							disabled: this.#busy,
							onclick: () => {
								this.#createOpen = false;
								this.rerender();
							}
						},
						this.t('backups.cancel')
					)
				)
			)
		);
	}

	// --- Backup copy (replica) -------------------------------------------------

	/** The transient setup UI under the active card: the destination choice or a
	 *  config form. The ATTACHED copy is not here - it rides inside the active
	 *  card (replicaAttachedLine). Idle renders nothing - the entry point lives
	 *  in the active card's menu. */
	private replicaSetup(): HTMLElement[] {
		const snap = this.#replicaSnap;
		if (!this.#replicaFlow || !snap || snap.replica) return [];
		if (snap.step === 'choose') return [this.replicaPicker(snap)];
		if (snap.step === 'form-webdav') return [this.replicaWebdavForm(snap)];
		if (snap.step === 'form-s3') return [this.replicaS3Form(snap)];
		return [];
	}

	/** The attached copy is not a backup of its own: it renders as ONE line
	 *  INSIDE the active backup's card, under its pills (label, freshness, an
	 *  inline "remove") - never a card or a block of its own. Null when no copy
	 *  is attached. */
	private replicaAttachedLine(): HTMLElement | null {
		const snap = this.#replicaSnap;
		if (!this.#replicaFlow || !snap || !snap.replica) return null;
		const rep = snap.replica;
		const label = rep.label;
		const status = rep.lastError
			? h('span', { part: 'sub replica-error' }, this.t('backups.replica.error'))
			: rep.lastPublishAt
				? h(
						'span',
						{ part: 'sub replica-ok' },
						this.ts('backups.replica.uptodate', {
							when: new Date(rep.lastPublishAt).toLocaleTimeString([], {
								hour: '2-digit',
								minute: '2-digit'
							})
						})
					)
				: h('span', { part: 'sub' }, this.t('backups.replica.pending'));
		return h(
			'div',
			{
				part: 'sub replica-line',
				'data-replica': '',
				style:
					'display:flex;flex-wrap:wrap;align-items:baseline;gap:0.1rem 0.5rem;margin-top:0.35rem'
			},
			h('span', { part: 'replica-label' }, this.ts('backups.replica.card', { label })),
			status,
			h(
				'button',
				{
					part: 'link replica-remove',
					type: 'button',
					'data-action': 'replica-remove',
					onclick: () =>
						this.guarded({ type: 'replica-remove', label }, () => void this.#replicaFlow?.remove())
				},
				this.t('backups.replica.remove')
			)
		);
	}

	private replicaPicker(snap: ReplicaSnapshot): HTMLElement {
		return h(
			'li',
			{ part: 'card replica-picker', style: 'display:block' },
			h('div', { part: 'title' }, this.t('backups.replica.title')),
			h('div', { part: 'sub', style: 'margin:0.2rem 0 0.6rem' }, this.t('backups.replica.intro')),
			...snap.kinds.map((kind: ConnectKind) =>
				h(
					'button',
					{
						part: 'button replica-dest',
						style: 'display:block;width:100%;text-align:left;margin-bottom:0.4rem',
						'data-kind': kind,
						disabled: snap.busy,
						onclick: () => this.#replicaFlow?.pick(kind)
					},
					this.t(`backups.replica.dest.${kind}`)
				)
			),
			snap.error ? h('div', { part: 'error-note' }, this.t('error.generic')) : null,
			h(
				'button',
				{
					part: 'button',
					'data-action': 'replica-cancel',
					disabled: snap.busy,
					onclick: () => this.#replicaFlow?.cancel()
				},
				this.t('backups.cancel')
			)
		);
	}

	/** A config field: mutates state on input, no repaint (validated on submit). */
	private replicaField(
		key: string,
		type: string,
		value: string,
		oninput: (v: string) => void
	): HTMLElement {
		return h('input', {
			part: 'input',
			style: 'display:block;width:100%;margin-bottom:0.4rem',
			type,
			placeholder: this.t(key),
			'aria-label': this.t(key),
			value,
			oninput: (e: Event) => oninput((e.target as HTMLInputElement).value)
		});
	}

	private replicaWebdavForm(snap: ReplicaSnapshot): HTMLElement {
		const c = this.#repWebdav;
		const submit = (): void => {
			if (!c.url.trim()) return;
			this.#replicaFlow?.submitWebdav({
				url: c.url.trim(),
				username: c.username.trim(),
				password: c.password
			});
		};
		return h(
			'li',
			{ part: 'card replica-form', style: 'display:block' },
			h('div', { part: 'title', style: 'margin-bottom:0.3rem' }, this.t('backups.replica.title')),
			h(
				'div',
				{ part: 'sub', style: 'margin-bottom:0.6rem' },
				this.t('backups.replica.webdav.help')
			),
			this.replicaField('backups.replica.webdav.url', 'url', c.url, (v) => (c.url = v)),
			this.replicaField('backups.replica.webdav.user', 'text', c.username, (v) => (c.username = v)),
			this.replicaField(
				'backups.replica.webdav.password',
				'password',
				c.password,
				(v) => (c.password = v)
			),
			snap.error ? h('div', { part: 'error-note' }, this.t('error.generic')) : null,
			h(
				'div',
				{ part: 'row', style: 'margin-top:0.45rem' },
				h(
					'button',
					{
						part: 'button button-primary',
						'data-action': 'replica-webdav',
						disabled: snap.busy,
						onclick: submit
					},
					this.t('backups.replica.save')
				),
				h(
					'button',
					{ part: 'button', disabled: snap.busy, onclick: () => this.#replicaFlow?.cancel() },
					this.t('backups.cancel')
				)
			)
		);
	}

	private replicaS3Form(snap: ReplicaSnapshot): HTMLElement {
		const c = this.#repS3;
		const submit = (): void => {
			const config: S3Config = {
				endpoint: c.endpoint.trim(),
				region: c.region.trim(),
				bucket: c.bucket.trim(),
				key: c.key.trim(),
				accessKeyId: c.accessKeyId.trim(),
				secretAccessKey: c.secretAccessKey
			};
			if (!config.endpoint || !config.region || !config.bucket || !config.key) return;
			if (!config.accessKeyId || !config.secretAccessKey) return;
			this.#replicaFlow?.submitS3(config);
		};
		return h(
			'li',
			{ part: 'card replica-form', style: 'display:block' },
			h('div', { part: 'title', style: 'margin-bottom:0.5rem' }, this.t('backups.replica.title')),
			this.replicaField('backups.replica.s3.endpoint', 'url', c.endpoint, (v) => (c.endpoint = v)),
			this.replicaField('backups.replica.s3.region', 'text', c.region, (v) => (c.region = v)),
			this.replicaField('backups.replica.s3.bucket', 'text', c.bucket, (v) => (c.bucket = v)),
			this.replicaField('backups.replica.s3.key', 'text', c.key, (v) => (c.key = v)),
			this.replicaField(
				'backups.replica.s3.accessKeyId',
				'text',
				c.accessKeyId,
				(v) => (c.accessKeyId = v)
			),
			this.replicaField(
				'backups.replica.s3.secret',
				'password',
				c.secretAccessKey,
				(v) => (c.secretAccessKey = v)
			),
			snap.error ? h('div', { part: 'error-note' }, this.t('error.generic')) : null,
			h(
				'div',
				{ part: 'row', style: 'margin-top:0.45rem' },
				h(
					'button',
					{
						part: 'button button-primary',
						'data-action': 'replica-s3',
						disabled: snap.busy,
						onclick: submit
					},
					this.t('backups.replica.save')
				),
				h(
					'button',
					{ part: 'button', disabled: snap.busy, onclick: () => this.#replicaFlow?.cancel() },
					this.t('backups.cancel')
				)
			)
		);
	}

	// --- Menu -----------------------------------------------------------------

	private menuButton(key: string): HTMLElement {
		return h(
			'button',
			{
				part: 'button menu-button',
				'aria-label': this.t('backups.menu'),
				'aria-haspopup': 'menu',
				'aria-expanded': this.#menuFor === key ? 'true' : 'false',
				'data-action': 'menu',
				'data-menu-key': key,
				disabled: this.#busy,
				onclick: () => {
					this.#menuFor = this.#menuFor === key ? null : key;
					this.rerender();
					(this.root.querySelector('[part~="menu"]') as HTMLElement | null)?.focus();
				}
			},
			'⋯'
		);
	}

	/** The open overflow menu: a backdrop closes it on any outside click or
	 *  tap, Escape closes it and hands focus back to its trigger. The panel is
	 *  a dropdown over the trigger's corner on wide screens and a bottom sheet
	 *  on phones - both styled in the base sheet. */
	private menu(...items: (HTMLElement | null)[]): HTMLElement {
		const key = this.#menuFor;
		const close = (): void => {
			this.#menuFor = null;
			this.rerender();
			(this.root.querySelector(`[data-menu-key="${key}"]`) as HTMLElement | null)?.focus();
		};
		return h(
			'div',
			{ part: 'menu-layer' },
			h('div', { part: 'menu-backdrop', 'data-action': 'menu-close', onclick: close }),
			h(
				'div',
				{
					part: 'menu',
					role: 'menu',
					tabindex: '-1',
					onkeydown: (e: Event) => {
						if ((e as KeyboardEvent).key === 'Escape') close();
					}
				},
				...items.filter((i): i is HTMLElement => i !== null)
			)
		);
	}

	private menuItem(action: string, text: string, danger: boolean, run: () => void): HTMLElement {
		return h(
			'button',
			{
				part: danger ? 'menu-item menu-item-danger' : 'menu-item',
				type: 'button',
				role: 'menuitem',
				'data-action': action,
				onclick: () => {
					this.#menuFor = null;
					run();
				}
			},
			text
		);
	}

	private eye(): HTMLElement {
		const btn = h('button', {
			part: 'eye',
			type: 'button',
			'aria-label': this.t(this.#pwShown ? 'backups.pwHide' : 'backups.pwShow'),
			onclick: () => {
				this.#pwShown = !this.#pwShown;
				this.rerender();
			}
		});
		btn.innerHTML = this.#pwShown ? EYE_SHUT : EYE_OPEN;
		return btn;
	}

	// --- Gestures --------------------------------------------------------------

	private nameTaken(label: string, exceptFileId: string | null): boolean {
		const clean = label.trim().toLowerCase();
		if (!clean || this.#busy) return false;
		return (this.#rows ?? []).some(
			(r) => r.fileId !== exceptFileId && r.label !== null && r.label.trim().toLowerCase() === clean
		);
	}

	/** Run a destructive action through the host's veto (default: proceed).
	 *  A throwing hook reads as "no": destruction needs a clear yes. */
	private guarded(action: BackupsAction, run: () => void): void {
		const gate = this.#confirmAction;
		if (!gate) {
			run();
			return;
		}
		void Promise.resolve()
			.then(() => gate(action))
			.then((ok) => {
				if (ok) run();
			})
			.catch(() => undefined);
	}

	/** Open a row programmatically - the same gesture as tapping it, password
	 *  card included. Lets a host chain "open this backup, then act on it"
	 *  (its own sub-views) without re-implementing the passphrase step. */
	async open(fileId: string, passphrase?: string): Promise<void> {
		const manager = this.#manager;
		if (!manager || this.#busy) return;
		this.#busy = true;
		this.#openBusy = fileId;
		this.rerender();
		try {
			const r = await manager.openBackup(fileId, passphrase ?? null);
			if (r === 'encrypted') {
				this.#pwFor = fileId;
				if (passphrase) this.emit('selfstore-backups-wrong-password', { fileId });
			} else if (r === 'ok') {
				this.closePw();
				this.emit('selfstore-backups-opened', { fileId });
				void this.loadRows();
			} else {
				this.emit('selfstore-backups-error', { code: manager.snapshot.lastError ?? 'failed' });
				void this.loadRows(); // a GONE file was pruned: repaint truthfully
			}
		} finally {
			this.#busy = false;
			this.#openBusy = null;
			this.rerender();
		}
	}

	private async create(): Promise<void> {
		const manager = this.#manager;
		const label = this.#createLabel.trim();
		if (!manager || !label || this.#busy) return;
		this.#busy = true;
		this.rerender();
		try {
			const r = await manager.createNamed(label);
			if (r === 'ok') {
				this.#createOpen = false;
				this.#createLabel = '';
				this.emit('selfstore-backups-created', { label });
				void this.loadRows();
			} else {
				this.emit('selfstore-backups-error', { code: manager.snapshot.lastError ?? 'failed' });
			}
		} finally {
			this.#busy = false;
			this.rerender();
		}
	}

	private async rename(row: BackupRow): Promise<void> {
		const manager = this.#manager;
		const label = this.#renameLabel.trim();
		if (!manager || !label || this.#busy) return;
		this.#busy = true;
		this.rerender();
		try {
			const r = await manager.renameBackup(row.fileId, label);
			if (r === 'ok') {
				this.#renameFor = null;
				this.emit('selfstore-backups-renamed', { fileId: row.fileId, label });
				void this.loadRows();
			} else {
				this.emit('selfstore-backups-error', { code: manager.snapshot.lastError ?? 'failed' });
			}
		} finally {
			this.#busy = false;
			this.rerender();
		}
	}

	private async deleteRow(fileId: string): Promise<void> {
		const manager = this.#manager;
		if (!manager || this.#busy) return;
		this.#busy = true;
		this.rerender();
		try {
			if (await manager.deleteBackup(fileId)) {
				this.#rows = (this.#rows ?? []).filter((r) => r.fileId !== fileId);
				this.emit('selfstore-backups-deleted', { fileId });
			} else {
				this.emit('selfstore-backups-error', { code: manager.snapshot.lastError ?? 'failed' });
			}
		} finally {
			this.#busy = false;
			this.rerender();
		}
	}

	private async forget(fileId: string): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		await manager.forgetShared(fileId);
		this.emit('selfstore-backups-forgotten', { fileId });
		this.rerender();
	}

	private closePw(): void {
		this.#pwFor = null;
		this.#pw = '';
		this.#pwShown = false;
	}
}

const pillStyle =
	'display:inline-block;font-size:0.72em;font-weight:600;line-height:1.6;padding:0 0.55em;border-radius:999px;border:1px solid var(--_border)';
