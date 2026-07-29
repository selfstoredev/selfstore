/**
 * <selfstore-gate>: the first-run screen that asks where the data should live,
 * before the app has a durable home. Data that lives only in a browser profile
 * dies with it, so the question is worth a screen of its own rather than a line
 * buried in a settings pane.
 *
 * It is a frame around <selfstore-connect>, and it decides ONE thing the plain
 * connect widget cannot: whether to be on screen at all. That condition is the
 * engine's own `status.action === 'choose-destination'`, which covers both an
 * ephemeral store and one still on the device-only cache, and which ranks a
 * destination needing attention above a missing one - so the gate never demands
 * a choice when the real problem is a broken connection.
 *
 *   import { defineSelfstoreWidgets } from 'selfstore/widgets';
 *   defineSelfstoreWidgets();
 *
 *   const el = document.querySelector('selfstore-gate');
 *   el.store = store;
 *   el.targets = { file: true, webdav: true };
 *
 * The host's own chrome goes in the light DOM through three slots: `brand`
 * (above the title), `extra` (under the destinations, e.g. a link to a demo)
 * and `footer` (the app's usual foot). Slotted nodes are never rebuilt.
 */

import type {
	ConnectFlowOptions,
	ConnectKind,
	ConnectTargets,
	FlowHost,
	StoreLike
} from '../flows/connect';
import type { SelfstoreConnectElement, WebdavPreset } from './connect';
import { FlowWidget, h, put, type WidgetLabels } from './base';

const EN: WidgetLabels = {
	'gate.title': 'Where should your data live?',
	'gate.hint':
		'It is encrypted on this device. Choose where to keep it and it gets saved there for you from now on.',
	'gate.fine': '',
	'gate.defer': 'Later - keep it in this browser only',
	'gate.defer.note': 'Data kept only in this browser is lost if its storage is cleared.'
};

const FR: WidgetLabels = {
	'gate.title': 'Où enregistrer vos données ?',
	'gate.hint':
		'Elles sont chiffrées sur cet appareil. Choisissez une sauvegarde : tout y sera enregistré automatiquement.',
	'gate.fine': '',
	'gate.defer': 'Plus tard - garder sur cet appareil seulement',
	'gate.defer.note':
		'Sans sauvegarde, les données disparaissent si le stockage de cet appareil est vidé.'
};

/** The overlay itself. The card is the query container the base styles expect,
 *  so the connect cards inside still react to their own width. */
const GATE_STYLES = `
:host { display: contents; }
[part~='gate'] {
	position: fixed;
	inset: 0;
	z-index: var(--selfstore-gate-z, 280);
	overflow-y: auto;
	background: var(--selfstore-gate-backdrop, Canvas);
	display: flex;
	flex-direction: column;
	align-items: center;
}
[part~='gate-card'] {
	width: 100%;
	max-width: var(--selfstore-gate-width, 30rem);
	box-sizing: border-box;
	padding: calc(2rem + env(safe-area-inset-top)) 1.25rem 1.5rem;
	display: flex;
	flex-direction: column;
	flex: 1 0 auto;
	gap: var(--_gap);
	container-type: inline-size;
	outline: none;
}
[part~='gate-title'] {
	margin: 0;
	font-size: var(--selfstore-gate-title-size, 1.5rem);
	font-weight: 700;
	line-height: 1.25;
}
button[part~='gate-defer'] { align-self: flex-start; text-align: left; }
[part~='gate-foot'] {
	flex-shrink: 0;
	width: 100%;
	padding-bottom: env(safe-area-inset-bottom);
}
`;

/** The tag the connect element took, derived from the gate's own registered
 *  name: both are defined together under the same prefix, so <app-gate> builds
 *  an <app-connect> without anyone having to tell it. */
function connectTagFor(gateTag: string): string {
	return gateTag.endsWith('-gate')
		? `${gateTag.slice(0, -'-gate'.length)}-connect`
		: 'selfstore-connect';
}

export class SelfstoreGateElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['armed', 'deferrable'];
	}

	#store: StoreLike | null = null;
	#targets: ConnectTargets | null = null;
	#options: ConnectFlowOptions = {};
	#icons: Partial<Record<ConnectKind, string>> = {};
	#recommended: ConnectKind | null = null;
	#advanced: ConnectKind[] = [];
	#presets: WebdavPreset[] = [];
	#armed = true;
	#deferrable = true;
	#deferred = false;
	#open = false;
	#connect: SelfstoreConnectElement | null = null;

	protected defaults(): WidgetLabels {
		return EN;
	}

	protected packs(): Record<string, WidgetLabels> {
		return { fr: FR };
	}

	/** The simple store (anything exposing `flowHost`), or a hand-built FlowHost. */
	get store(): StoreLike | null {
		return this.#store;
	}
	set store(v: StoreLike | null) {
		// Idempotent, so a host may assign it from a reactive effect: see the
		// note on <selfstore-connect>.
		if (v === this.#store) return;
		this.#store = v;
		this.wire();
	}

	/** The destinations to offer, exactly as <selfstore-connect> takes them.
	 *  Read when the gate opens; a change while it is open waits for the next
	 *  opening rather than rebuilding a journey under the user. */
	get targets(): ConnectTargets | null {
		return this.#targets;
	}
	set targets(v: ConnectTargets | null) {
		this.#targets = v;
	}

	/** Options for the connect flow (`defaultResolution`, `password`, ...).
	 *  Same timing as `targets`. */
	get options(): ConnectFlowOptions {
		return this.#options;
	}
	set options(v: ConnectFlowOptions) {
		this.#options = v ?? {};
	}

	get icons(): Partial<Record<ConnectKind, string>> {
		return this.#icons;
	}
	set icons(v: Partial<Record<ConnectKind, string>> | null) {
		this.#icons = v ?? {};
		this.rerender();
	}

	get recommended(): ConnectKind | null {
		return this.#recommended;
	}
	set recommended(v: ConnectKind | null) {
		this.#recommended = v;
		this.rerender();
	}

	get advanced(): ConnectKind[] {
		return this.#advanced;
	}
	set advanced(v: ConnectKind[] | null) {
		this.#advanced = v ?? [];
		this.rerender();
	}

	get webdavPresets(): WebdavPreset[] {
		return this.#presets;
	}
	set webdavPresets(v: WebdavPreset[] | null) {
		this.#presets = Array.isArray(v) ? v : [];
		this.rerender();
	}

	/** Whether the app has finished booting. Leave it true for a plain drop-in;
	 *  an app that restores its destination asynchronously sets it false until
	 *  that settles, so a connected user never glimpses the gate on the way in.
	 *  Also the `armed` attribute (`armed="false"` to hold it shut). */
	get armed(): boolean {
		return this.#armed;
	}
	set armed(v: boolean) {
		this.#armed = v;
		this.sync();
	}

	/** Whether to offer the way out (device-only is a working mode, just a
	 *  fragile one). Also the `deferrable` attribute. Part of the frame, so it
	 *  follows the same timing as `targets`: read when the gate opens. */
	get deferrable(): boolean {
		return this.#deferrable;
	}
	set deferrable(v: boolean) {
		this.#deferrable = v;
	}

	/** Set once the user chose to stay device-only; keeps the gate shut for the
	 *  rest of the session. Assign false to bring it back (a "choose a
	 *  destination" entry somewhere else in the app). */
	get deferred(): boolean {
		return this.#deferred;
	}
	set deferred(v: boolean) {
		this.#deferred = v;
		this.sync();
	}

	/** Whether the gate is currently on screen. */
	get open(): boolean {
		return this.#open;
	}

	/** The connect element the gate built, for programmatic control (its own
	 *  `flow` included). Null while the gate is shut. */
	get connect(): SelfstoreConnectElement | null {
		return this.#connect;
	}

	constructor() {
		super();
		this.root.append(h('style', {}, GATE_STYLES));
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'armed') this.armed = value !== 'false';
		if (name === 'deferrable') this.deferrable = value !== 'false';
	}

	connectedCallback(): void {
		super.connectedCallback();
		if (this.hasAttribute('armed')) this.armed = this.getAttribute('armed') !== 'false';
		if (this.hasAttribute('deferrable')) {
			this.deferrable = this.getAttribute('deferrable') !== 'false';
		}
		this.wire();
	}

	private host(): FlowHost | null {
		const s = this.#store;
		if (!s) return null;
		return 'flowHost' in s ? s.flowHost : s;
	}

	private wire(): void {
		if (!this.isConnected) return;
		this.unsub?.();
		this.unsub = null;
		const host = this.host();
		if (!host) return;
		this.unsub = host.engine.subscribe(() => this.sync());
		this.sync();
	}

	/** The library already derives "no durable home yet" - asking the target
	 *  kind by hand would miss the ranking and nag over a broken connection. */
	private shouldOpen(): boolean {
		const host = this.host();
		if (!host || !this.#armed || this.#deferred) return false;
		return host.engine.state.status.action === 'choose-destination';
	}

	private sync(): void {
		const open = this.shouldOpen();
		if (open === this.#open) return; // a status tick that changes nothing
		this.#open = open;
		if (!open) this.#connect = null;
		super.rerender();
		if (open) this.root.querySelector<HTMLElement>('[part~="gate-card"]')?.focus();
	}

	/** Rebuilding the frame would re-append the child connect element, and a
	 *  custom element that leaves the DOM and comes back rebuilds its flow: a
	 *  journey in progress would be dropped on the floor. So while the gate is
	 *  open the frame stands and late cosmetics are pushed into the child.
	 *  Set `labels` before `store` for them to reach the frame's own copy. */
	protected rerender(): void {
		const el = this.#connect;
		if (!el) {
			super.rerender();
			return;
		}
		el.labels = this.childLabels();
		el.icons = this.#icons;
		el.recommended = this.#recommended;
		el.advanced = this.#advanced;
		el.webdavPresets = this.#presets;
	}

	/** The gate's title already asks the question; the child's heading would
	 *  repeat it. An empty label removes a heading, and a host that wants it
	 *  back just says so in its own map. */
	private childLabels(): WidgetLabels {
		return { 'connect.title': '', ...this.labels };
	}

	private buildConnect(): SelfstoreConnectElement {
		const el = document.createElement(
			connectTagFor(this.tagName.toLowerCase())
		) as SelfstoreConnectElement;
		el.labels = this.childLabels();
		el.icons = this.#icons;
		el.recommended = this.#recommended;
		el.advanced = this.#advanced;
		el.webdavPresets = this.#presets;
		el.options = this.#options;
		el.targets = this.#targets;
		// Last, and before the element enters the DOM: every one of these setters
		// wires the flow, and the store is what makes wiring possible at all.
		el.store = this.#store;
		return el;
	}

	private deferButton(): HTMLElement | null {
		if (!this.#deferrable) return null;
		const note = this.t('gate.defer.note');
		return h(
			'div',
			{},
			h(
				'button',
				{
					part: 'link gate-defer',
					type: 'button',
					onclick: () => {
						this.deferred = true;
						this.emit('selfstore-gate-deferred');
					}
				},
				this.t('gate.defer')
			),
			note ? h('div', { part: 'hint gate-defer-note' }, note) : null
		);
	}

	protected view(into: HTMLElement): void {
		if (!this.#open) return;
		this.#connect = this.buildConnect();
		const title = h('h1', { part: 'gate-title', id: 'gate-title' }, this.t('gate.title'));
		const card = h('div', {
			part: 'gate-card',
			tabindex: '-1'
		});
		put(
			card,
			h('slot', { name: 'brand' }),
			title,
			this.heading('sub gate-hint', 'gate.hint'),
			this.#connect,
			h('slot', { name: 'extra' }),
			this.heading('hint gate-fine', 'gate.fine'),
			this.deferButton()
		);
		put(
			into,
			h(
				'div',
				{
					part: 'gate',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-labelledby': 'gate-title'
				},
				card,
				h('div', { part: 'gate-foot' }, h('slot', { name: 'footer' }))
			)
		);
	}
}
