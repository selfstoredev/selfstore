// <selfstore-share>: the share panel over shareFlow, driving an app-provided
// ShareEngine (how links travel is the app's business).
//
// One link per level: each level shows its live link or offers to create it.
// No second write link next to a first (which one was live?), no name to
// invent - the level says what it is. Links the engine lists always render,
// whatever `levels` says: the panel never hides an access that exists.
//
// Knobs (all optional): levels, with-create / with-members, confirmAction
// (host veto over destructive actions), qrProvider (injected, so the element
// stays zero-dependency). Engines exposing revokeAll get a "stop sharing"
// foot link, rendered only once somebody besides you is in the member list.

import { shareFlow, type ShareEngine, type ShareFlow, type ShareLevel } from '../flows/share';
import { FlowWidget, h, put, type WidgetLabels } from './base';

const EN: WidgetLabels = {
	'share.title': 'Sharing',
	'share.create.read': 'Create a view link',
	'share.create.write': 'Create an edit link',
	'share.creating': 'Creating...',
	'share.level.read': 'Can view',
	'share.level.write': 'Can edit',
	'share.copy': 'Copy',
	'share.copied': 'Copied',
	'share.revoke': 'Revoke',
	'share.members': 'People with access',
	'share.member.you': 'you',
	'share.member.owner': 'owner',
	'share.remove': 'Remove',
	'share.stop': 'Stop sharing',
	'share.empty': 'Nobody else has access yet.',
	'share.stale': 'Connection hiccup: this view may be behind.',
	'error.generic': 'That did not work. Check the connection and try again.',
	'error.targetUnavailable': 'The share service did not answer. Try again in a moment.'
};

/** A destructive action, offered to confirmAction before it runs: a row's
 *  revoke/remove, or 'stop' - ending the whole share. */
export type ShareAction = { type: 'revoke' | 'remove'; id: string } | { type: 'stop' };

/** "off"-style attribute values; anything else (including empty) reads as on. */
const isOff = (v: string | null): boolean =>
	v != null && ['off', 'false', 'no', '0'].includes(v.trim().toLowerCase());

export class SelfstoreShareElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['levels', 'with-create', 'with-members'];
	}

	#engine: ShareEngine | null = null;
	#flow: ShareFlow | null = null;
	#options: { deadlineMs?: number } = {};
	#levels: ShareLevel[] = ['read', 'write'];
	#withCreate = true;
	#withMembers = true;
	#confirmAction: ((action: ShareAction) => boolean | Promise<boolean>) | null = null;
	#qrProvider: ((url: string) => Promise<string>) | null = null;
	#qr = new Map<string, string>();
	#qrPending = new Set<string>();
	#copiedId: string | null = null;
	#creating: ShareLevel | null = null;

	protected defaults(): WidgetLabels {
		return EN;
	}

	/** The app-side transport of links and memberships (see ShareEngine). */
	get engine(): ShareEngine | null {
		return this.#engine;
	}
	set engine(v: ShareEngine | null) {
		this.#engine = v;
		this.wire();
	}

	/** Flow options (deadlineMs), for engines whose legs outgrow the default
	 *  30s guard (a large first upload, a slow relay). */
	get options(): { deadlineMs?: number } {
		return this.#options;
	}
	set options(v: { deadlineMs?: number } | null) {
		this.#options = v ?? {};
		this.wire();
	}

	/** Which levels the panel OFFERS to create (['read', 'write'] by default) -
	 *  one create button per level without a live link. Also the `levels`
	 *  attribute, comma-separated: levels="read". Links the engine lists
	 *  render whatever this says. */
	get levels(): ShareLevel[] {
		return [...this.#levels];
	}
	set levels(v: ShareLevel[]) {
		const clean = [...new Set((v ?? []).filter((l) => l === 'read' || l === 'write'))];
		this.#levels = clean.length > 0 ? clean : ['read', 'write'];
		this.rerender();
	}

	/** Render the create buttons (default). `with-create="off"` hides them: the
	 *  panel becomes list-and-revoke only. */
	get withCreate(): boolean {
		return this.#withCreate;
	}
	set withCreate(v: boolean) {
		this.#withCreate = v !== false;
		this.rerender();
	}

	/** Render the members section (default). `with-members="off"` hides it:
	 *  a links-only panel. */
	get withMembers(): boolean {
		return this.#withMembers;
	}
	set withMembers(v: boolean) {
		this.#withMembers = v !== false;
		this.rerender();
	}

	/** Host veto over the destructive actions: called before revoke, remove or
	 *  stop runs; answer (or resolve) false to keep things as they are -
	 *  window.confirm fits as-is. Default: everything proceeds. */
	get confirmAction(): ((action: ShareAction) => boolean | Promise<boolean>) | null {
		return this.#confirmAction;
	}
	set confirmAction(v: ((action: ShareAction) => boolean | Promise<boolean>) | null) {
		this.#confirmAction = v ?? null;
	}

	/** Turn a link URL into an image source (a data URL fits): when set, each
	 *  link card renders it as an img part="qr". Injected so the element ships
	 *  no QR dependency. */
	get qrProvider(): ((url: string) => Promise<string>) | null {
		return this.#qrProvider;
	}
	set qrProvider(v: ((url: string) => Promise<string>) | null) {
		this.#qrProvider = v ?? null;
		this.#qr.clear();
		this.#qrPending.clear();
		this.rerender();
	}

	get flow(): ShareFlow | null {
		return this.#flow;
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'levels') {
			this.levels = (value ?? '').split(',').map((s) => s.trim()) as ShareLevel[];
		}
		if (name === 'with-create') this.withCreate = value == null || !isOff(value);
		if (name === 'with-members') this.withMembers = value == null || !isOff(value);
	}

	connectedCallback(): void {
		this.wire();
	}

	private wire(): void {
		if (!this.isConnected || !this.#engine) return;
		this.unsub?.();
		this.#flow = shareFlow(this.#engine, this.#options);
		this.unsub = this.#flow.subscribe(() => this.rerender());
	}

	protected view(into: HTMLElement): void {
		const flow = this.#flow;
		if (!flow) return;
		const s = flow.snapshot;

		put(into, this.heading('title', 'share.title'));
		if (s.stale) into.append(h('div', { part: 'hint' }, this.t('share.stale')));
		if (s.error && !s.stale) {
			into.append(h('div', { part: 'error-note' }, this.errorText(s.error.labelKey)));
		}

		// One link per level: a level with a live link shows it below instead of
		// offering a second one. One gesture per missing level, nothing to name.
		if (this.#withCreate) {
			const missing = this.#levels.filter((l) => !s.links.some((k) => k.level === l));
			if (missing.length > 0) {
				into.append(
					h(
						'div',
						{ part: 'row' },
						...missing.map((level) =>
							h(
								'button',
								{
									part: 'button button-primary',
									'data-action': `create-${level}`,
									disabled: s.busy !== null,
									onclick: () => this.create(level)
								},
								this.t(
									s.busy === 'create' && this.#creating === level
										? 'share.creating'
										: `share.create.${level}`
								)
							)
						)
					)
				);
			}
		}

		if (s.links.length > 0) {
			const list = h('ul', { part: 'list' });
			for (const link of s.links) {
				const qr = this.qrFor(link.url);
				list.append(
					h(
						'li',
						{ part: 'card', 'data-link': link.id },
						qr ? h('img', { part: 'qr', src: qr, alt: '' }) : null,
						h(
							'div',
							{ style: 'flex:1;min-width:0' },
							h('div', { part: 'title' }, this.t(`share.level.${link.level}`)),
							h('div', { part: 'sub', style: 'word-break:break-all' }, link.url)
						),
						h(
							'button',
							{ part: 'button', 'data-action': 'copy', onclick: () => this.copy(link.id, link.url) },
							this.t(this.#copiedId === link.id ? 'share.copied' : 'share.copy')
						),
						h(
							'button',
							{ part: 'button button-danger', 'data-action': 'revoke', disabled: s.busy !== null, onclick: () => this.revoke(link.id) },
							this.t('share.revoke')
						)
					)
				);
			}
			into.append(list);
		}

		if (this.#withMembers) {
			put(into, this.heading('sub', 'share.members'));
			if (s.members.length === 0) {
				into.append(h('div', { part: 'hint' }, this.t('share.empty')));
			} else {
				const members = h('ul', { part: 'list' });
				for (const m of s.members) {
					const badges: string[] = [];
					if (m.self) badges.push(this.t('share.member.you'));
					if (m.owner) badges.push(this.t('share.member.owner'));
					members.append(
						h(
							'li',
							{ part: 'card', 'data-member': m.id },
							h(
								'div',
								{ style: 'flex:1' },
								h('div', { part: 'title' }, m.label || m.id),
								badges.length ? h('div', { part: 'sub' }, badges.join(' - ')) : null
							),
							s.canRemoveMembers && !m.self
								? h(
										'button',
										{ part: 'button button-danger', 'data-action': 'remove', disabled: s.busy !== null, onclick: () => this.removeRow(m.id) },
										this.t('share.remove')
									)
								: null
						)
					);
				}
				into.append(members);
			}
		}

		// Ending the whole share: a quiet link at the panel's foot, not a banner.
		// Rare, destructive, and only real when the engine has such a move and
		// somebody besides you is in - kicking nobody is noise, and a share
		// nobody joined yet ends by revoking its link.
		if (s.canRevokeAll && s.members.some((m) => !m.self)) {
			into.append(
				h(
					'div',
					{ part: 'footer', style: 'text-align:right' },
					h(
						'button',
						{ part: 'link link-danger', 'data-action': 'stop', disabled: s.busy !== null, onclick: () => this.stop() },
						this.t('share.stop')
					)
				)
			);
		}
	}

	private create(level: ShareLevel): void {
		this.#creating = level;
		void this.#flow?.createLink({ level }).then((link) => {
			this.#creating = null;
			if (link) this.emit('selfstore-link-created', { link });
			this.rerender();
		});
	}

	/** Run a destructive action through the host's veto (default: proceed).
	 *  A throwing hook reads as "no": destruction needs a clear yes. */
	private guarded(action: ShareAction, run: () => void): void {
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

	private revoke(id: string): void {
		this.guarded({ type: 'revoke', id }, () => void this.#flow?.revokeLink(id));
	}

	private removeRow(id: string): void {
		this.guarded({ type: 'remove', id }, () => void this.#flow?.removeMember(id));
	}

	private stop(): void {
		this.guarded({ type: 'stop' }, () => {
			void this.#flow?.revokeAll().then((ok) => {
				if (ok) this.emit('selfstore-share-stopped');
			});
		});
	}

	private qrFor(url: string): string | null {
		const provider = this.#qrProvider;
		if (!provider) return null;
		const got = this.#qr.get(url);
		if (got) return got;
		if (!this.#qrPending.has(url)) {
			this.#qrPending.add(url);
			void provider(url)
				.then((src) => {
					if (this.#qrProvider !== provider) return; // swapped since: stale image
					this.#qr.set(url, src);
					this.rerender();
				})
				.catch(() => undefined)
				.finally(() => this.#qrPending.delete(url));
		}
		return null;
	}

	private copy(id: string, url: string): void {
		this.#copiedId = id;
		this.emit('selfstore-link-copied', { url });
		void navigator.clipboard?.writeText(url).catch(() => undefined);
		this.rerender();
		setTimeout(() => {
			if (this.#copiedId !== id) return;
			this.#copiedId = null;
			this.rerender();
		}, 1500);
	}
}
