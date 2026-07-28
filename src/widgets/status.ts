// <selfstore-status>: the store's save status. Renders the engine's own
// StatusDescriptor - the widget never invents a state. variant="row" is a
// severity dot + status line + one action button (settings panel, menu);
// variant="dot" is just the dot as an aria-labelled button (header corner).
// An actionable status emits 'selfstore-status-action' with the suggested
// action; what it means (open settings, run reconnect) is the host's call.

import type { FlowHost, StoreLike } from '../flows/connect';
import { FlowWidget, h, put, type WidgetLabels } from './base';

// The browser is never named as the PLACE the data lives. It is not one: it
// holds a working copy that a cleared profile takes with it. So the state with
// no destination names what is MISSING - nothing has been saved out - instead
// of describing the browser as an address, which reads reassuring and is not.
const EN: WidgetLabels = {
	'status.ephemeral': 'Nothing is saved',
	'status.cacheOnly': 'Never saved anywhere yet',
	'status.saving': 'Saving...',
	'status.saved': 'Saved to {label}, at every change',
	'status.needsAttention': 'Reconnect to continue',
	'status.locked': 'Locked',
	'status.pendingDownload': 'Changes to download',
	'status.saved.placeless': 'Saved',
	'status.action.choose-destination': 'Choose a destination',
	'status.action.download': 'Download',
	'status.action.reconnect': 'Reconnect',
	'status.action.unlock': 'Unlock'
};

// A pill states a condition, never a possession: "Sauvegarde à jour", not "Ma
// sauvegarde". One verb, one meaning: Exporter is always the portable copy.
const FR: WidgetLabels = {
	'status.ephemeral': "Rien n'est enregistré",
	'status.cacheOnly': "Vos données n'ont jamais été enregistrées ailleurs",
	'status.saving': 'Enregistrement...',
	'status.saved': 'Enregistré dans {label}, à chaque changement',
	'status.needsAttention': 'Accès à retrouver',
	'status.locked': 'Sauvegarde verrouillée',
	'status.pendingDownload': 'Modifications à exporter',
	'status.saved.placeless': 'Sauvegarde à jour',
	'status.action.choose-destination': 'Choisir une sauvegarde',
	'status.action.download': 'Exporter',
	'status.action.reconnect': "Retrouver l'accès",
	'status.action.unlock': 'Déverrouiller'
};

export class SelfstoreStatusElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['variant'];
	}

	#store: StoreLike | null = null;
	#variant: 'row' | 'dot' = 'row';
	#icons: Record<string, string> = {};

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

	/** 'row' (dot + text + action) or 'dot' (the dot alone). Also the attribute. */
	get variant(): 'row' | 'dot' {
		return this.#variant;
	}
	set variant(v: 'row' | 'dot' | null) {
		this.#variant = v === 'dot' ? 'dot' : 'row';
		this.rerender();
	}

	/** Optional icon per target kind (e.g. { drive: url, file: url }), shown
	 *  before the text in the row variant. Same contract as the connect cards. */
	get icons(): Record<string, string> {
		return this.#icons;
	}
	set icons(v: Record<string, string> | null) {
		this.#icons = v ?? {};
		this.rerender();
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'variant') this.variant = value as 'row' | 'dot' | null;
	}

	connectedCallback(): void {
		if (this.hasAttribute('variant')) this.variant = this.getAttribute('variant') as 'row' | 'dot';
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
		this.unsub = host.engine.subscribe(() => this.rerender());
		this.rerender();
	}

	protected view(into: HTMLElement): void {
		const host = this.host();
		if (!host) return; // inert until wired
		const { status, targetKind, label } = host.engine.state;
		// The destination's own name is offered to the sentence. A pack that uses
		// {label} says where in one line; one that does not is unaffected, and the
		// name still appears on the sub-line below. A target can be attached and
		// still have no name to give, so a sentence built around the place has a
		// placeless twin - otherwise it would render the placeholder itself.
		const sansLieu = (cle: string): string => {
			const jumelle = `${cle}.placeless`;
			const copie = this.t(jumelle);
			// Pas de jumelle declaree: la cle de base ne parle deja pas du lieu.
			return copie === jumelle ? this.t(cle) : copie;
		};
		const text = label ? this.t(status.labelKey, { label }) : sansLieu(status.labelKey);
		const dot = h('span', {
			part: `status-dot sev-${status.severity}`,
			'aria-hidden': 'true'
		});

		if (this.#variant === 'dot') {
			into.append(
				h(
					'button',
					{
						part: 'dot-button',
						'aria-label': text,
						title: text,
						onclick: () => this.emit('selfstore-status-action', { action: status.action ?? null })
					},
					dot
				)
			);
			return;
		}

		const icon = this.#icons[targetKind];
		const where = this.t(`status.where.${targetKind}`);
		// `status.where.<kind>` is a host-provided label; the raw key means "not
		// provided" - fall back to the target's own label (file name, server).
		const sub = where !== `status.where.${targetKind}` ? where : (label ?? '');
		put(
			into,
			h(
				'div',
				{ part: 'row status-row' },
				dot,
				icon ? h('img', { part: 'icon', src: icon, alt: '' }) : null,
				h(
					'div',
					{},
					h('div', { part: 'title' }, text),
					sub ? h('div', { part: 'sub' }, sub) : null
				),
				status.actionable && status.action
					? h(
							'button',
							{
								part: 'button status-action',
								onclick: () => this.emit('selfstore-status-action', { action: status.action })
							},
							this.t(`status.action.${status.action}`)
						)
					: null
			)
		);
	}
}
