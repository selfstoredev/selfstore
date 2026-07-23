/**
 * <selfstore-connect>: the "where does my data live" journey, ready to drop
 * in. A thin skin over connectFlow - every ordering and failure rule lives in
 * the flow (and its tests); this element only renders the snapshot and calls
 * the actions. Theme it with --selfstore-* custom properties and ::part()
 * selectors; reword or localize it through the `labels` property.
 *
 *   import { defineSelfstoreWidgets } from 'selfstore/widgets';
 *   defineSelfstoreWidgets();
 *
 *   const el = document.querySelector('selfstore-connect');
 *   el.store = store;                                  // simple store (or a FlowHost)
 *   el.targets = { drive: gisDriveAuth({ clientId }), file: true };
 *   el.addEventListener('selfstore-connected', (e) => ...e.detail.outcome...);
 */

import type { WebdavConfig } from '../persistence/targets/webdav';
import type { S3Config } from '../persistence/targets/s3';
import {
	connectFlow,
	type ConnectFlow,
	type ConnectFlowOptions,
	type ConnectKind,
	type ConnectSnapshot,
	type ConnectTargets,
	type FlowHost
} from '../flows/connect';
import { FlowWidget, h, put, type WidgetLabels } from './base';

/** A named WebDAV provider offered in the connect form's quick-pick row, so a
 *  user can start from their host instead of a blank URL field. selfstore ships
 *  no list - the app supplies whichever providers it wants to surface (its own
 *  server, a sovereign host, ...); the widget just renders them and pre-fills the
 *  URL field on pick. Pure UI sugar over the same WebDAV form. */
export interface WebdavPreset {
	/** Stable id (also the `data-preset` attribute, for theming/tests). */
	id: string;
	/** Button text: the provider or host name. */
	label: string;
	/** Base server URL that pre-fills the WebDAV URL field when picked. Omit for a
	 *  label-only entry (the user then types the full URL themselves). */
	url?: string;
	/** Optional guidance, shown as a line under the form once this preset is
	 *  picked (e.g. where to find the app password for this host) and as the
	 *  quick-pick button's tooltip. */
	help?: string;
	/** Optional link appended to the `help` line (e.g. a how-to page). */
	helpUrl?: string;
	/** Optional "create an account" link shown once this preset is picked, for a
	 *  user who has no account with the host yet. The app owns the URL; selfstore
	 *  hard-codes no provider. */
	signupUrl?: string;
}

const EN: WidgetLabels = {
	'connect.title': 'Where should we save your data?',
	'connect.recommended': 'Recommended',
	'connect.drive': 'Google Drive',
	'connect.drive.sub': 'Available on all your devices',
	'connect.file': 'A file on this device',
	'connect.file.sub': 'Offline, you keep the file',
	'connect.file.new': 'New backup',
	'connect.file.open': 'Load an existing file',
	'connect.webdav': 'My own server (WebDAV)',
	'connect.webdav.sub': 'Nextcloud, ownCloud, yours',
	'connect.s3': 'My own bucket (S3)',
	'connect.s3.sub': 'Amazon S3, R2, B2, MinIO',
	'connect.server': 'My own server',
	'connect.server.sub': 'WebDAV or an S3 bucket you control',
	'connect.tab.webdav': 'WebDAV',
	'connect.tab.s3': 'S3',
	'connect.s3.endpoint': 'Endpoint URL',
	'connect.s3.region': 'Region',
	'connect.s3.bucket': 'Bucket',
	'connect.s3.key': 'Object key (path)',
	'connect.s3.accessKeyId': 'Access key ID',
	'connect.s3.secret': 'Secret access key',
	'connect.s3.submit': 'Connect',
	'connect.connecting': 'Connecting...',
	'connect.connecting.drive': 'Authorise access in the Google window.',
	'connect.cancel': 'Cancel',
	'connect.retry': 'Try again',
	'connect.password.title': 'This backup is protected',
	'connect.password.hint': 'Enter its password to open it.',
	'connect.password.placeholder': 'Password',
	'connect.password.wrong': 'Wrong password. Try again.',
	'connect.password.submit': 'Open',
	'connect.password.show': 'Show password',
	'connect.password.hide': 'Hide password',
	'connect.password.forgot': 'Forgot the password?',
	'connect.password.forgot.warn':
		'Without the password, this backup cannot be opened. You can erase it and start from an empty one. The old backup is lost for good.',
	'connect.password.forgot.confirm': 'Overwrite the backup',
	'connect.password.forgot.back': 'Back',
	'connect.conflict.title': 'This destination already holds a backup',
	'connect.conflict.merge': 'Merge both',
	'connect.conflict.merge.sub': 'Keep everything from both sides',
	'connect.conflict.resume': 'Use the backup',
	'connect.conflict.resume.sub': 'This device adopts it',
	'connect.conflict.replace': 'Replace the backup',
	'connect.conflict.replace.sub': 'This device wins, the backup is overwritten',
	'connect.webdav.url': 'Server URL',
	'connect.webdav.user': 'Username',
	'connect.webdav.password': 'Password',
	'connect.webdav.submit': 'Connect',
	'connect.webdav.signup': 'Create an account',
	'connect.webdav.help.more': 'How?',
	'connect.done': 'Connected. Your data is saved.',
	'connect.done.manual': 'Download mode: save the file after each change.',
	'error.generic': 'That did not work. Check the connection and try again.',
	'error.targetUnavailable': 'The destination did not answer. Try again in a moment.',
	'error.authExpired': 'Access expired: reconnect to continue.',
	'error.decryptFailed': 'This backup could not be opened with that password.',
	'error.badFormat': 'This file does not look like a readable backup.'
};

// Two glyphs for the password eye: an open eye when the value is hidden (click
// to reveal), a struck-through eye when it is shown (click to hide). Plain
// stroke SVG, currentColor, so they inherit the host's text color like any icon.
const EYE_SHOW =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_HIDE =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M6.61 6.61A18.45 18.45 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

/** Build the eye glyph for the current visibility (shown value -> struck eye). */
function eyeIcon(visible: boolean): SVGElement {
	const span = document.createElement('span');
	span.innerHTML = visible ? EYE_HIDE : EYE_SHOW;
	return span.firstElementChild as SVGElement;
}

export class SelfstoreConnectElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['recommended', 'advanced'];
	}

	#store: FlowHost | { flowHost: FlowHost } | null = null;
	#targets: ConnectTargets | null = null;
	#options: ConnectFlowOptions = {};
	#flow: ConnectFlow | null = null;
	#recommended: ConnectKind | null = null;
	#icons: Partial<Record<ConnectKind, string>> = {};
	#advanced: ConnectKind[] = [];
	#webdavPresets: WebdavPreset[] = [];
	#webdavUrl = '';
	#webdavUser = '';
	#webdavPass = '';
	#pickedPreset: WebdavPreset | null = null;
	// S3 form fields (kept on the element, like the WebDAV ones, so switching the
	// server tab never loses what was typed).
	#s3Endpoint = '';
	#s3Region = '';
	#s3Bucket = '';
	#s3Key = '';
	#s3AccessKeyId = '';
	#s3Secret = '';
	// Password-step local UI state (never in the flow: purely how this element
	// draws the step). Reset whenever the flow leaves 'password' (see wire()).
	#pwVisible = false;
	#confirmOverwrite = false;

	protected defaults(): WidgetLabels {
		return EN;
	}

	/** The simple store (anything exposing `flowHost`), or a hand-built FlowHost. */
	get store(): FlowHost | { flowHost: FlowHost } | null {
		return this.#store;
	}
	set store(v: FlowHost | { flowHost: FlowHost } | null) {
		this.#store = v;
		this.wire();
	}

	get targets(): ConnectTargets | null {
		return this.#targets;
	}
	set targets(v: ConnectTargets | null) {
		this.#targets = v;
		this.wire();
	}

	get options(): ConnectFlowOptions {
		return this.#options;
	}
	set options(v: ConnectFlowOptions) {
		this.#options = v ?? {};
		this.wire();
	}

	/** Badge one destination as the one to pick (part="tag", label
	 *  'connect.recommended'). Purely a highlight: the order still follows the
	 *  targets object. Also the `recommended` attribute. Default: none. */
	get recommended(): ConnectKind | null {
		return this.#recommended;
	}
	set recommended(v: ConnectKind | null) {
		this.#recommended = v === 'drive' || v === 'file' || v === 'webdav' || v === 's3' ? v : null;
		this.rerender();
	}

	/** An optional icon per destination - an image URL or data URI, rendered as
	 *  part="icon" at the head of that card. Purely decorative and per-instance;
	 *  omit a kind for no icon. Size it with --selfstore-icon-size. */
	get icons(): Partial<Record<ConnectKind, string>> {
		return this.#icons;
	}
	set icons(v: Partial<Record<ConnectKind, string>> | null) {
		this.#icons = v ?? {};
		this.rerender();
	}

	/** Destinations to tuck behind a discreet link under the cards instead of a
	 *  full card - for power-user options (say, WebDAV) that must stay reachable
	 *  without weighing the everyday choice. Also the `advanced` attribute
	 *  (comma-separated). The journey after the click is exactly the same. */
	get advanced(): ConnectKind[] {
		return this.#advanced;
	}
	set advanced(v: ConnectKind[] | null) {
		this.#advanced = (v ?? []).filter(
			(k) => k === 'drive' || k === 'file' || k === 'webdav' || k === 's3'
		);
		this.rerender();
	}

	/** Named WebDAV providers offered as a quick-pick row above the WebDAV form,
	 *  pre-filling the URL field. The app owns the list (its own host, sovereign
	 *  providers, ...); selfstore ships none. Purely additive - the blank form
	 *  still works. */
	get webdavPresets(): WebdavPreset[] {
		return this.#webdavPresets;
	}
	set webdavPresets(v: WebdavPreset[] | null) {
		this.#webdavPresets = Array.isArray(v) ? v : [];
		this.rerender();
	}

	/** The underlying flow, for programmatic control (may be null until wired). */
	get flow(): ConnectFlow | null {
		return this.#flow;
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'recommended') this.recommended = value as ConnectKind | null;
		if (name === 'advanced') {
			this.advanced = (value ?? '').split(',').map((s) => s.trim()) as ConnectKind[];
		}
	}

	connectedCallback(): void {
		if (this.#recommended === null && this.hasAttribute('recommended')) {
			this.recommended = this.getAttribute('recommended') as ConnectKind;
		}
		if (this.#advanced.length === 0 && this.hasAttribute('advanced')) {
			this.advanced = (this.getAttribute('advanced') ?? '')
				.split(',')
				.map((s) => s.trim()) as ConnectKind[];
		}
		this.wire();
	}

	private wire(): void {
		if (!this.isConnected || !this.#store || !this.#targets) return;
		this.unsub?.();
		this.#flow = connectFlow(this.#store, this.#targets, this.#options);
		let last: ConnectSnapshot | null = null;
		this.unsub = this.#flow.subscribe((snap) => {
			const was = last;
			last = snap;
			if (snap.step === 'connected' && was?.step !== 'connected') {
				this.emit('selfstore-connected', { outcome: snap.outcome });
			}
			if (snap.step === 'error' && was?.step !== 'error') {
				this.emit('selfstore-error', { error: snap.error });
			}
			// Leaving the password step clears its local UI state, so a later
			// return starts masked and on the form (not on a stale confirmation).
			if (snap.step !== 'password') {
				this.#pwVisible = false;
				this.#confirmOverwrite = false;
			}
			this.rerender();
		});
	}

	protected view(into: HTMLElement): void {
		const flow = this.#flow;
		if (!flow) return; // inert until wired
		const s = flow.snapshot;

		if (s.step === 'choose') {
			put(into, this.heading('title', 'connect.title'));
			// WebDAV and S3 are both "your own server": when both are offered as
			// cards, fold them into one entry that opens the tabbed form, so a new
			// backend never adds another top-level button.
			const serverKinds = (['webdav', 's3'] as const).filter(
				(k) => s.kinds.includes(k) && !this.#advanced.includes(k)
			);
			const groupServer = serverKinds.length >= 2;
			for (const kind of s.kinds) {
				if (this.#advanced.includes(kind)) continue;
				if (groupServer && (kind === 'webdav' || kind === 's3')) {
					if (kind === serverKinds[0]) into.append(this.serverCard(serverKinds[0]));
					continue;
				}
				into.append(this.destCard(kind));
			}
			// The tucked-away destinations: same journey, discreet entry.
			for (const kind of s.kinds) {
				if (this.#advanced.includes(kind)) {
					into.append(
						h(
							'button',
							{
								part: 'link advanced-link',
								'data-kind': kind,
								onclick: () => this.#flow?.choose(kind)
							},
							this.t(`connect.${kind}`)
						)
					);
				}
			}
			return;
		}

		if (s.step === 'form') {
			const kind = s.kind === 's3' ? 's3' : 'webdav';
			// The WebDAV/S3 toggle shows only when both are offered as form kinds
			// (a fixed config skips the form and never reaches here).
			const tabbed =
				(['webdav', 's3'] as const).filter((k) => this.#targets?.[k] === true).length >= 2;
			const children: HTMLElement[] = [
				h('div', { part: 'title' }, this.t(tabbed ? 'connect.server' : `connect.${kind}`))
			];
			if (tabbed) children.push(this.serverTabs(kind));
			children.push(...(kind === 's3' ? this.s3FormChildren(flow) : this.webdavFormChildren(flow)));
			into.append(...children);
			return;
		}

		if (s.step === 'authorizing') {
			into.append(
				h(
					'div',
					{ part: 'status' },
					h('span', { part: 'spinner', 'aria-hidden': 'true' }),
					h(
						'div',
						{},
						h('div', { part: 'title' }, this.t('connect.connecting')),
						s.kind === 'drive'
							? h('div', { part: 'sub' }, this.t('connect.connecting.drive'))
							: null
					),
					h('button', { part: 'button', onclick: () => this.cancel() }, this.t('connect.cancel'))
				)
			);
			return;
		}

		if (s.step === 'password') {
			// Escape sub-state: the password is forgotten - confirm erasing the
			// protected backup before overwrite() makes it unrecoverable.
			if (this.#confirmOverwrite) {
				put(
					into,
					h('div', { part: 'title' }, this.t('connect.password.title')),
					h('div', { part: 'hint warn-note' }, this.t('connect.password.forgot.warn')),
					h(
						'div',
						{ part: 'row' },
						h(
							'button',
							{ part: 'button button-danger', disabled: s.busy, onclick: () => this.doOverwrite() },
							this.t('connect.password.forgot.confirm')
						),
						h(
							'button',
							{ part: 'button', disabled: s.busy, onclick: () => this.setConfirmOverwrite(false) },
							this.t('connect.password.forgot.back')
						)
					)
				);
				return;
			}
			// The password field wears a show/hide eye. The eye toggles the input
			// type in place (never a re-render) so the typed value is never lost.
			const field = h(
				'div',
				{ part: 'field' },
				h('input', {
					part: 'input',
					type: this.#pwVisible ? 'text' : 'password',
					placeholder: this.t('connect.password.placeholder'),
					'data-keep': 'password',
					autocomplete: 'current-password'
				}),
				h(
					'button',
					{
						part: 'eye',
						type: 'button',
						'aria-label': this.t(
							this.#pwVisible ? 'connect.password.hide' : 'connect.password.show'
						),
						'aria-pressed': this.#pwVisible ? 'true' : 'false',
						onclick: () => this.togglePassword()
					},
					eyeIcon(this.#pwVisible)
				)
			);
			put(
				into,
				h('div', { part: 'title' }, this.t('connect.password.title')),
				h('div', { part: 'hint' }, this.t('connect.password.hint')),
				field,
				s.passwordError ? h('div', { part: 'error-note' }, this.t('connect.password.wrong')) : null,
				h(
					'div',
					{ part: 'row' },
					h(
						'button',
						{
							part: 'button button-primary',
							disabled: s.busy,
							onclick: () => this.submitPassword()
						},
						this.t('connect.password.submit')
					),
					// Cancel is never disabled, even mid-trial-read: a hung leg must
					// always have a working way out. The generation counter makes a
					// late resolution of the abandoned leg a no-op, so leaving is safe.
					h('button', { part: 'button', onclick: () => this.cancel() }, this.t('connect.cancel'))
				),
				// The forgotten-password escape: a discreet link into the confirm
				// sub-state above (erasing the backup is never one careless click).
				h(
					'button',
					{ part: 'link forgot-link', onclick: () => this.setConfirmOverwrite(true) },
					this.t('connect.password.forgot')
				)
			);
			return;
		}

		if (s.step === 'conflict') {
			into.append(h('div', { part: 'title' }, this.t('connect.conflict.title')));
			for (const how of ['merge', 'resume', 'replace'] as const) {
				into.append(
					h(
						'button',
						{ part: 'card', disabled: s.busy, onclick: () => flow.resolveConflict(how) },
						h(
							'div',
							{},
							h('div', { part: 'title' }, this.t(`connect.conflict.${how}`)),
							h('div', { part: 'sub' }, this.t(`connect.conflict.${how}.sub`))
						)
					)
				);
			}
			into.append(
				h('button', { part: 'link', onclick: () => this.cancel() }, this.t('connect.cancel'))
			);
			return;
		}

		if (s.step === 'connected') {
			into.append(
				h(
					'div',
					{ part: 'status status-ok' },
					h(
						'div',
						{ part: 'title' },
						this.t(s.outcome === 'manual' ? 'connect.done.manual' : 'connect.done')
					)
				)
			);
			return;
		}

		// error: retry goes back to the choices; cancel is always offered too, so
		// a failing destination is never a dead end (the host hears
		// selfstore-cancelled and can dismiss the widget entirely).
		into.append(
			h(
				'div',
				{ part: 'status status-error' },
				h('div', { part: 'title' }, this.errorText(s.error?.labelKey))
			),
			h(
				'div',
				{ part: 'row' },
				h(
					'button',
					{ part: 'button button-primary', onclick: () => flow.retry() },
					this.t('connect.retry')
				),
				h('button', { part: 'button', onclick: () => this.cancel() }, this.t('connect.cancel'))
			)
		);
	}

	private destCard(kind: ConnectKind): HTMLElement {
		const icon = this.#icons[kind];
		const head = icon ? h('img', { part: 'icon', src: icon, alt: '' }) : null;
		const title = h(
			'div',
			{ part: 'title' },
			this.t(`connect.${kind}`),
			this.#recommended === kind ? h('span', { part: 'tag' }, this.t('connect.recommended')) : null
		);
		const sub = h('div', { part: 'sub' }, this.t(`connect.${kind}.sub`));

		// A file target declared with the object form offers TWO gestures on one
		// card: start a new backup, or adopt an existing file. Buttons cannot
		// nest, so this card is a div carrying its own action row. The open
		// gesture needs the browser's open picker; without it only new remains.
		const fileSpec = kind === 'file' ? this.#targets?.file : null;
		if (fileSpec && typeof fileSpec === 'object') {
			const openSupported = typeof window !== 'undefined' && 'showOpenFilePicker' in window;
			const actions = h('div', { part: 'row' });
			if (fileSpec.create != null) {
				actions.append(
					h(
						'button',
						{
							part: 'button button-primary',
							'data-action': 'create',
							onclick: () => this.#flow?.choose('file', 'create')
						},
						this.t('connect.file.new')
					)
				);
			}
			if (fileSpec.open != null && (typeof fileSpec.open === 'function' || openSupported)) {
				actions.append(
					h(
						'button',
						{
							part: 'button',
							'data-action': 'open',
							onclick: () => this.#flow?.choose('file', 'open')
						},
						this.t('connect.file.open')
					)
				);
			}
			const body = h('div', {}, title, sub);
			if (actions.childElementCount > 0) body.append(actions);
			return h('div', { part: 'card', 'data-kind': kind }, head, body);
		}

		return h(
			'button',
			{ part: 'card', 'data-kind': kind, onclick: () => this.#flow?.choose(kind) },
			head,
			h('div', {}, title, sub)
		);
	}

	/** The grouped "your own server" card shown when both WebDAV and S3 are
	 *  offered: one entry into the tabbed form, opening on the first server kind. */
	private serverCard(defaultKind: ConnectKind): HTMLElement {
		const recommended = this.#recommended === 'webdav' || this.#recommended === 's3';
		return h(
			'button',
			{ part: 'card', 'data-kind': 'server', onclick: () => this.#flow?.choose(defaultKind) },
			h(
				'div',
				{},
				h(
					'div',
					{ part: 'title' },
					this.t('connect.server'),
					recommended ? h('span', { part: 'tag' }, this.t('connect.recommended')) : null
				),
				h('div', { part: 'sub' }, this.t('connect.server.sub'))
			)
		);
	}

	/** WebDAV/S3 segmented toggle. Switching leaves the form and re-enters it on
	 *  the other kind - no flow surgery - and the typed fields live on the element,
	 *  so nothing the user wrote is lost across the switch. */
	private serverTabs(active: ConnectKind): HTMLElement {
		const tab = (k: 'webdav' | 's3'): HTMLElement =>
			h(
				'button',
				{
					part: active === k ? 'tab tab-on' : 'tab',
					type: 'button',
					'data-tab': k,
					'aria-pressed': active === k ? 'true' : 'false',
					onclick: () => {
						if (active === k) return;
						this.#flow?.cancel();
						this.#flow?.choose(k);
					}
				},
				this.t(`connect.tab.${k}`)
			);
		return h('div', { part: 'tabs' }, tab('webdav'), tab('s3'));
	}

	private webdavFormChildren(flow: ConnectFlow): HTMLElement[] {
		const picked = this.#pickedPreset;
		const out: HTMLElement[] = [];
		// Optional quick-pick row: the app's WebDAV providers, pre-filling the URL.
		if (this.#webdavPresets.length > 0) {
			out.push(
				h(
					'div',
					{ part: 'presets' },
					...this.#webdavPresets.map((p) =>
						h(
							'button',
							{
								part: picked?.id === p.id ? 'preset preset-on' : 'preset',
								type: 'button',
								'data-preset': p.id,
								'aria-pressed': picked?.id === p.id ? 'true' : 'false',
								title: p.help ?? '',
								onclick: () => this.pickWebdavPreset(p)
							},
							p.label
						)
					)
				)
			);
		}
		out.push(
			h('input', {
				part: 'input',
				type: 'url',
				placeholder: this.t('connect.webdav.url'),
				'data-keep': 'wd-url',
				value: this.#webdavUrl,
				oninput: (e: Event) => (this.#webdavUrl = (e.target as HTMLInputElement).value)
			}),
			h('input', {
				part: 'input',
				type: 'text',
				placeholder: this.t('connect.webdav.user'),
				'data-keep': 'wd-user',
				value: this.#webdavUser,
				oninput: (e: Event) => (this.#webdavUser = (e.target as HTMLInputElement).value)
			}),
			h('input', {
				part: 'input',
				type: 'password',
				placeholder: this.t('connect.webdav.password'),
				'data-keep': 'wd-pass',
				value: this.#webdavPass,
				oninput: (e: Event) => (this.#webdavPass = (e.target as HTMLInputElement).value)
			})
		);
		// A picked provider may carry guidance and a sign-up link (no account yet).
		if (picked?.help) {
			out.push(
				h(
					'div',
					{ part: 'hint webdav-note' },
					picked.help,
					picked.helpUrl
						? h(
								'a',
								{
									part: 'link webdav-help',
									href: picked.helpUrl,
									target: '_blank',
									rel: 'noopener noreferrer'
								},
								` ${this.t('connect.webdav.help.more')}`
							)
						: null
				)
			);
		}
		out.push(
			h(
				'div',
				{ part: 'row' },
				h(
					'button',
					{ part: 'button button-primary', onclick: () => this.submitWebdav() },
					this.t('connect.webdav.submit')
				),
				h('button', { part: 'button', onclick: () => flow.cancel() }, this.t('connect.cancel'))
			)
		);
		if (picked?.signupUrl) {
			out.push(
				h(
					'a',
					{
						part: 'link webdav-signup',
						href: picked.signupUrl,
						target: '_blank',
						rel: 'noopener noreferrer'
					},
					this.t('connect.webdav.signup')
				)
			);
		}
		return out;
	}

	private s3FormChildren(flow: ConnectFlow): HTMLElement[] {
		const field = (
			type: string,
			label: string,
			keep: string,
			get: () => string,
			set: (v: string) => void
		): HTMLElement =>
			h('input', {
				part: 'input',
				type,
				placeholder: this.t(label),
				'data-keep': keep,
				value: get(),
				oninput: (e: Event) => set((e.target as HTMLInputElement).value)
			});
		return [
			field(
				'url',
				'connect.s3.endpoint',
				's3-endpoint',
				() => this.#s3Endpoint,
				(v) => (this.#s3Endpoint = v)
			),
			field(
				'text',
				'connect.s3.region',
				's3-region',
				() => this.#s3Region,
				(v) => (this.#s3Region = v)
			),
			field(
				'text',
				'connect.s3.bucket',
				's3-bucket',
				() => this.#s3Bucket,
				(v) => (this.#s3Bucket = v)
			),
			field(
				'text',
				'connect.s3.key',
				's3-key',
				() => this.#s3Key,
				(v) => (this.#s3Key = v)
			),
			field(
				'text',
				'connect.s3.accessKeyId',
				's3-akid',
				() => this.#s3AccessKeyId,
				(v) => (this.#s3AccessKeyId = v)
			),
			field(
				'password',
				'connect.s3.secret',
				's3-secret',
				() => this.#s3Secret,
				(v) => (this.#s3Secret = v)
			),
			h(
				'div',
				{ part: 'row' },
				h(
					'button',
					{ part: 'button button-primary', onclick: () => this.submitS3() },
					this.t('connect.s3.submit')
				),
				h('button', { part: 'button', onclick: () => flow.cancel() }, this.t('connect.cancel'))
			)
		];
	}

	private submitS3(): void {
		const endpoint = this.#s3Endpoint.trim();
		const region = this.#s3Region.trim();
		const bucket = this.#s3Bucket.trim();
		const key = this.#s3Key.trim();
		if (!endpoint || !region || !bucket || !key) return;
		const config: S3Config = {
			endpoint,
			region,
			bucket,
			key,
			accessKeyId: this.#s3AccessKeyId.trim(),
			secretAccessKey: this.#s3Secret
		};
		this.#flow?.submitS3(config);
	}

	private cancel(): void {
		this.#flow?.cancel();
		this.emit('selfstore-cancelled');
	}

	private submitPassword(): void {
		const input = this.root.querySelector<HTMLInputElement>('[data-keep="password"]');
		if (input) this.#flow?.submitPassword(input.value);
	}

	/** Flip the password field between hidden and shown IN PLACE - swap the
	 *  input type and the eye glyph without a re-render, so what the user has
	 *  already typed survives the toggle. */
	private togglePassword(): void {
		this.#pwVisible = !this.#pwVisible;
		const input = this.root.querySelector<HTMLInputElement>('[data-keep="password"]');
		if (input) {
			input.type = this.#pwVisible ? 'text' : 'password';
			input.focus();
		}
		const eye = this.root.querySelector<HTMLButtonElement>('[part~="eye"]');
		if (eye) {
			eye.setAttribute(
				'aria-label',
				this.t(this.#pwVisible ? 'connect.password.hide' : 'connect.password.show')
			);
			eye.setAttribute('aria-pressed', this.#pwVisible ? 'true' : 'false');
			eye.replaceChildren(eyeIcon(this.#pwVisible));
		}
	}

	/** Enter or leave the forgotten-password confirmation sub-state. */
	private setConfirmOverwrite(on: boolean): void {
		this.#confirmOverwrite = on;
		this.rerender();
	}

	/** Confirmed: abandon the forgotten password and start a fresh backup over
	 *  the protected one (the flow makes this device win). */
	private doOverwrite(): void {
		this.#flow?.overwrite();
	}

	/** Fill the WebDAV URL field from a picked provider preset and move focus on to
	 *  the username, so the pick just seeds the form the user then completes. The
	 *  pick is remembered so its guidance / sign-up link render and its chip flags
	 *  as active; a re-render keeps the already-typed username and password. */
	private pickWebdavPreset(p: WebdavPreset): void {
		this.#pickedPreset = p;
		this.#webdavUrl = p.url ?? '';
		this.rerender();
		this.root.querySelector<HTMLInputElement>('[data-keep="wd-user"]')?.focus();
	}

	private submitWebdav(): void {
		const url = this.#webdavUrl.trim();
		if (!url) return;
		const config: WebdavConfig = {
			url,
			username: this.#webdavUser.trim(),
			password: this.#webdavPass
		};
		this.#flow?.submitWebdav(config);
	}
}
