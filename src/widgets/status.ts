// <selfstore-status>: the store's save status. Renders the engine's own
// StatusDescriptor - the widget never invents a state. variant="row" is a
// severity dot + status line + one action button (settings panel, menu);
// variant="dot" is just the dot as an aria-labelled button (header corner).
// An actionable status emits 'selfstore-status-action' with the suggested
// action; what it means (open settings, run reconnect) is the host's call.

import { FlowWidget, h, put, type WidgetLabels } from './base';
import { EN as KIND_EN, FR as KIND_FR } from './kinds';

// The browser is never named as the PLACE the data lives. It is not one: it
// holds a working copy that a cleared profile takes with it. So the state with
// no destination names what is MISSING - nothing has been saved out - instead
// of describing the browser as an address, which reads reassuring and is not.
const EN: WidgetLabels = {
	...KIND_EN,
	'status.justNow': 'just now',
	'status.ephemeral': 'Nothing is saved',
	'status.cacheOnly': 'Never saved anywhere yet',
	'status.copy': 'Last copy written {when}. Nothing has changed since.',
	'status.copyStale': 'Last copy written {when}. What you typed since is not in it.',
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
	...KIND_FR,
	'status.justNow': "a l'instant",
	'status.ephemeral': "Rien n'est enregistré",
	'status.cacheOnly': "Vos données n'ont jamais été enregistrées ailleurs",
	'status.copy': "Dernière copie écrite {when}. Rien n'a changé depuis.",
	'status.copyStale': "Dernière copie écrite {when}. Vos saisies depuis n'y sont pas.",
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

/** The state, said in one sign before the sentence is read: a saved backup is a
 *  tick, anything asking for a gesture is a mark. A dot alone made "saved" and
 *  "reconnect to continue" look like the same notice in two colors.
 *
 *  This is also the channel that carries severity when color cannot: the ok and
 *  warn tokens were darkened for contrast until they share a luminance, so on a
 *  greyscale screen, or to someone who sees no color, the glyph is the whole
 *  difference. Module scope, so it is not rebuilt on every render. */
export const GLYPH: Record<string, string> = { ok: '✓', warn: '!', danger: '!', info: '' };

export class SelfstoreStatusElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['variant'];
	}

	#variant: 'row' | 'line' | 'dot' = 'row';

	protected defaults(): WidgetLabels {
		return EN;
	}

	protected packs(): Record<string, WidgetLabels> {
		return { fr: FR };
	}

	/**
	 * 'row' (a tinted box: dot, text, action button - for a settings page),
	 * 'line' (one line and a link - for a menu, where a box eats the surface),
	 * or 'dot' (the dot alone, for a header corner). Also the attribute.
	 */
	get variant(): 'row' | 'line' | 'dot' {
		return this.#variant;
	}
	set variant(v: 'row' | 'line' | 'dot' | null) {
		this.#variant = v === 'dot' || v === 'line' ? v : 'row';
		this.rerender();
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'variant') this.variant = value as 'row' | 'line' | 'dot' | null;
	}

	connectedCallback(): void {
		super.connectedCallback();
		// This element's whole job is to say when the situation changed - and it
		// said it to sighted users only. `role="status"` makes the host a polite
		// live region, so "saving", "access expired", "reconnect to continue" are
		// announced when they appear, in every variant, without a second copy of
		// the sentence to keep in step. Polite and not assertive on purpose: it
		// must not cut across someone mid-sentence for a state they can act on
		// whenever they choose. Set on the HOST, so an app that wants other
		// wording can still override the attribute from the outside.
		if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
		if (this.hasAttribute('variant'))
			this.variant = this.getAttribute('variant') as 'row' | 'line' | 'dot';
		this.follow(this.hostOf());
	}

	protected view(into: HTMLElement): void {
		const host = this.hostOf();
		if (!host) return; // inert until wired
		const { status, targetKind, label } = host.engine.state;
		// The destination's own name is offered to the sentence. A pack that uses
		// {label} says where in one line; one that does not is unaffected, and the
		// name still appears on the sub-line below. A target can be attached and
		// still have no name to give, so a sentence built around the place has a
		// placeless twin - otherwise it would render the placeholder itself.
		const sansLieu = (cle: string): string => {
			const jumelle = `${cle}.placeless`;
			const copie = this.t(jumelle, vars);
			// Pas de jumelle declaree: la cle de base ne parle deja pas du lieu.
			return copie === jumelle ? this.t(cle, vars) : copie;
		};
		/**
		 * La jumelle PAR TYPE de destination, quand une application en donne une.
		 *
		 * Un cabinet dit "Fichier a jour" ou "Serveur a jour" - pas la meme
		 * phrase, parce que ce n'est pas le meme objet, et le nom du fichier
		 * n'ajoute rien quand il n'y a qu'un endroit possible. Une seule cle pour
		 * les deux forcait a choisir laquelle des deux phrases serait fausse.
		 * Absente, rien ne change : c'est la phrase de base qui parle.
		 */
		const selonLeType = (cle: string): string | null => {
			const jumelle = `${cle}.${targetKind}`;
			const copie = this.t(jumelle, vars);
			return copie === jumelle ? null : copie;
		};
		const { lastSavedAt, lastCopyAt } = host.engine.state;
		// The words a sentence can ask for: where it was saved, and when the last
		// copy was written. A pack that mentions neither is unaffected.
		const vars = {
			label: label ?? '',
			when: lastCopyAt ? this.since(lastCopyAt, this.t('status.justNow')) : ''
		};
		const text =
			selonLeType(status.labelKey) ??
			(label ? this.t(status.labelKey, vars) : sansLieu(status.labelKey));
		const dot = h('span', {
			part: `status-dot sev-${status.severity}`,
			'aria-hidden': 'true'
		});
		const glyph = GLYPH[status.severity];
		const sign = glyph
			? h('span', { part: `status-glyph sev-${status.severity}`, 'aria-hidden': 'true' }, glyph)
			: dot;

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

		if (this.#variant === 'line') {
			// A menu is 17 rem wide and already carries a card. The box, with its
			// own padding, took 247 px of it - most of that one sentence wrapping
			// inside a column meant for an address. One line, and a link.
			put(
				into,
				h(
					'div',
					{ part: 'row status-line' },
					sign,
					h('span', { part: 'status-line-text' }, text),
					status.actionable && status.action
						? h(
								'button',
								{
									part: 'link status-action',
									type: 'button',
									onclick: () => this.emit('selfstore-status-action', { action: status.action })
								},
								this.t(`status.action.${status.action}`)
							)
						: null
				)
			);
			return;
		}

		// The box states the situation before it is read: the severity tints it.
		const TINT: Record<string, string> = {
			ok: 'status-ok',
			warn: 'status-warn',
			danger: 'status-error',
			info: ''
		};
		const icon = this.icons[targetKind];
		// The sub-line answers "where, and when" the way a settings page does:
		// "Google Drive, 2 minutes ago". The DESTINATION is named there, not the
		// backup file, so the title above stops repeating a name it already gave -
		// which is why it takes its placeless twin whenever this line is present.
		const where = this.t(`status.where.${targetKind}`);
		const kindName = this.t(`destination.kind.${targetKind}`);
		// A file IS its name, so its name is the place. A service is named by the
		// service - "quitalo.zip" would be the backup file INSIDE it, which says
		// nothing about where the data went; which account it is belongs to the
		// panel's card, next to the address.
		const named = kindName === `destination.kind.${targetKind}` ? null : kindName;
		const own = targetKind === 'drive' ? null : label;
		const place = where !== `status.where.${targetKind}` ? where : (own ?? named ?? label ?? '');
		const when = lastSavedAt ? this.since(lastSavedAt, this.t('status.justNow')) : '';
		const sub = [place, status.state === 'saved' ? when : ''].filter(Boolean).join(', ');
		// The place is on the line below now, so the sentence above stops naming
		// it - unless the app worded this kind itself, which outranks both.
		const title = selonLeType(status.labelKey) ?? (sub ? sansLieu(status.labelKey) : text);
		put(
			into,
			h(
				'div',
				{ part: `status row status-row ${TINT[status.severity] ?? ''}` },
				// The severity colors the sign, not the box: tinting the whole line
				// turns a title into a warning about itself.
				sign,
				icon ? h('img', { part: 'icon', src: icon, alt: '' }) : null,
				h(
					'div',
					{},
					h('div', { part: 'title' }, title),
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
