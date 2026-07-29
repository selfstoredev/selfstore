/**
 * <selfstore-destination>: where the data is kept, once it has a home.
 *
 * The counterpart of <selfstore-gate>. The gate asks the question before there
 * is an answer; this panel states the answer and carries the gestures that act
 * on it - export a copy, change destination, stop saving here.
 *
 *   const el = document.querySelector('selfstore-destination');
 *   el.store = store;
 *   el.targets = { drive: driveAuth, file: true }; // enables "change"
 *
 * It DOES the work rather than asking the host to. Exporting a copy, detaching
 * and re-connecting are all the engine's own operations, so a panel that only
 * emitted intentions would leave the same two hundred lines in every app - the
 * very lines this widget exists to delete.
 *
 * The one exception is structural, not a choice: **loading a copy back cannot
 * be done from here.** The library holds no records; the app's `apply` does.
 * The engine exposes `exportBlob()` and no import, so the panel asks for that
 * one through `selfstore-destination-action` and the host runs its own import.
 *
 * Two things stay the host's, deliberately: the WORDS (every label is
 * overridable, and a pack ships per language) and the VETO on what is
 * destructive (`confirmAction`, which defaults to proceeding). Neither is
 * customisation - they are the decisions a library must not take for an app.
 */

import type { ConnectKind, ConnectTargets, FlowHost, StoreLike } from '../flows/connect';
import type { SelfstoreConnectElement } from './connect';
import { datedName, saveToDisk } from '../selfstore/targets/local';
import { FlowWidget, h, hostOf, put, type WidgetLabels } from './base';

/** What the panel is about to do, for the host's veto. */
export interface DestinationAction {
	type: 'detach';
	/** The destination's own name, when it has one. */
	label: string | null;
}

const EN: WidgetLabels = {
	'destination.heading': 'Where your data is kept',
	'destination.kind.drive': 'Google Drive',
	'destination.kind.file': 'A file on this device',
	'destination.kind.webdav': 'Your own server',
	'destination.kind.s3': 'Your own bucket',
	'destination.kind.device': 'This device only',
	'destination.encrypted': 'Password-protected',
	'destination.export': 'Export a copy',
	'destination.exported': 'The copy is written.',
	'destination.exportCancelled': 'Nothing was written.',
	'destination.restore': 'Load a copy',
	'destination.change': 'Change destination',
	'destination.detach': 'Stop saving here',
	'destination.detached': 'Stopped. Your data stays on this device.',
	'destination.back': 'Back',
	'error.generic': 'Something went wrong.'
};

// One verb per gesture, and the precious thing is never the object of the verb:
// "ne plus enregistrer ici" says what stops, where "detacher cette sauvegarde"
// would read as taking the backup away.
const FR: WidgetLabels = {
	'destination.heading': 'Où vos données sont enregistrées',
	'destination.kind.drive': 'Google Drive',
	'destination.kind.file': 'Un fichier sur cet appareil',
	'destination.kind.webdav': 'Votre serveur',
	'destination.kind.s3': 'Votre bucket',
	'destination.kind.device': 'Cet appareil seulement',
	'destination.encrypted': 'Protégée par un mot de passe',
	'destination.export': 'Exporter une copie',
	'destination.exported': 'La copie est écrite.',
	'destination.exportCancelled': "Rien n'a été écrit.",
	'destination.restore': 'Charger une copie',
	'destination.change': 'Changer de destination',
	'destination.detach': 'Ne plus enregistrer ici',
	'destination.detached': 'Arrêté. Vos données restent sur cet appareil.',
	'destination.back': 'Retour',
	'error.generic': "Quelque chose n'a pas fonctionné."
};

const DESTINATION_STYLES = `
[part~='destination-card'] { align-items: flex-start; }
[part~='destination-actions'] {
	display: flex;
	flex-wrap: wrap;
	gap: var(--_gap);
}
[part~='destination-heading'] {
	margin: 0;
	font-size: 1rem;
	font-weight: 600;
}
`;

/** The sibling element under the same prefix: both are registered together, so
 *  <app-destination> composes <app-connect> without being told. */
function siblingTag(own: string, name: string): string {
	const suffix = '-destination';
	return own.endsWith(suffix) ? `${own.slice(0, -suffix.length)}-${name}` : `selfstore-${name}`;
}

export class SelfstoreDestinationElement extends FlowWidget {
	#store: StoreLike | null = null;
	#targets: ConnectTargets | null = null;
	#account: string | null = null;
	#icons: Partial<Record<ConnectKind, string>> = {};
	#confirm: ((a: DestinationAction) => boolean | Promise<boolean>) | null = null;
	#changing = false;
	#busy = false;
	#message: string | null = null;

	protected defaults(): WidgetLabels {
		return EN;
	}

	protected packs(): Record<string, WidgetLabels> {
		return { fr: FR };
	}

	constructor() {
		super();
		this.root.append(h('style', {}, DESTINATION_STYLES));
	}

	/** The simple store (anything exposing `flowHost`), or a hand-built FlowHost. */
	get store(): StoreLike | null {
		return this.#store;
	}
	set store(v: StoreLike | null) {
		if (v === this.#store) return;
		this.#store = v;
		this.wire();
	}

	/** The destinations offered when the user changes their mind. Given them, the
	 *  panel runs the connect journey in place; without them the button is absent
	 *  rather than dead - a host that cannot offer a choice should not show one. */
	get targets(): ConnectTargets | null {
		return this.#targets;
	}
	set targets(v: ConnectTargets | null) {
		this.#targets = v;
		this.rerender();
	}

	/** Who holds the destination ("someone@example.com"), when the host knows.
	 *  For Drive that is `driveTarget.account()`: a brand name is not an address,
	 *  and several accounts look alike. */
	get account(): string | null {
		return this.#account;
	}
	set account(v: string | null) {
		this.#account = v || null;
		this.rerender();
	}

	/** Optional glyph per destination kind, same contract as the connect cards. */
	get icons(): Partial<Record<ConnectKind, string>> {
		return this.#icons;
	}
	set icons(v: Partial<Record<ConnectKind, string>> | null) {
		this.#icons = v ?? {};
		this.rerender();
	}

	/** Veto on what is destructive. Returns false (or throws) to stop; absent
	 *  means proceed. The panel never invents its own confirm dialog: an app has
	 *  its own words and its own modal. */
	get confirmAction(): ((a: DestinationAction) => boolean | Promise<boolean>) | null {
		return this.#confirm;
	}
	set confirmAction(fn: ((a: DestinationAction) => boolean | Promise<boolean>) | null) {
		this.#confirm = fn;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.wire();
	}

	private host(): FlowHost | null {
		return hostOf(this.#store);
	}

	private wire(): void {
		this.follow(this.host());
	}

	/** Run a gesture, keeping the panel honest while it is in flight. */
	private async run(job: () => Promise<string | null>): Promise<void> {
		this.#busy = true;
		this.#message = null;
		this.rerender();
		try {
			this.#message = await job();
		} catch {
			this.#message = this.t('error.generic');
		} finally {
			this.#busy = false;
			this.rerender();
		}
	}

	/** A portable copy, on the user's own terms. A closed save dialog wrote
	 *  nothing, so it must not clear the pending-export nudge nor claim success -
	 *  that is the download that lies about itself. */
	private exportCopy(): Promise<void> {
		const host = this.host();
		if (!host) return Promise.resolve();
		return this.run(async () => {
			const blob = await host.engine.exportBlob();
			const written = await saveToDisk(blob, datedName(host.backupName));
			if (!written) return this.t('destination.exportCancelled');
			host.engine.markDownloaded();
			return this.t('destination.exported');
		});
	}

	/** Stop saving to this destination. The local data stays, and so does the
	 *  backup already written: this detaches, it never deletes. */
	private detach(label: string | null): Promise<void> {
		const host = this.host();
		if (!host) return Promise.resolve();
		return this.run(async () => {
			// A throwing hook reads as "no": stopping is a decision, and an
			// undecided answer must not be taken for a yes.
			try {
				if (this.#confirm && !(await this.#confirm({ type: 'detach', label }))) return null;
			} catch {
				return null;
			}
			await host.engine.detachTarget();
			this.emit('selfstore-destination-detached');
			return this.t('destination.detached');
		});
	}

	/** The connect journey, in place. Built like the gate builds it, so the
	 *  destinations, the password step and the cancel path are the library's
	 *  tested ones rather than a second implementation. */
	private connectView(into: HTMLElement): void {
		const el = document.createElement(
			siblingTag(this.localName, 'connect')
		) as SelfstoreConnectElement;
		el.store = this.#store;
		el.targets = this.#targets;
		el.icons = this.#icons;
		el.labels = this.labels;
		const done = (): void => {
			this.#changing = false;
			this.rerender();
		};
		el.addEventListener('selfstore-connected', done);
		el.addEventListener('selfstore-cancelled', done);
		put(
			into,
			h(
				'button',
				{ part: 'link destination-back', type: 'button', onclick: done },
				this.t('destination.back')
			),
			el
		);
	}

	protected view(into: HTMLElement): void {
		const host = this.host();
		if (!host) return; // inert until wired
		if (this.#changing && this.#targets) return this.connectView(into);

		const { targetKind, label, encrypted } = host.engine.state;
		const kind = this.t(`destination.kind.${targetKind}`);
		// An unknown kind (a host's own target) has no shipped name: its own label
		// is a better answer than the raw key.
		const title = kind === `destination.kind.${targetKind}` ? (label ?? targetKind) : kind;
		const sub = [this.#account, label && label !== title ? label : null]
			.filter(Boolean)
			.join(' · ');
		const icon = this.#icons[targetKind as ConnectKind];
		const status = document.createElement(siblingTag(this.localName, 'status')) as HTMLElement & {
			store?: StoreLike | null;
			labels?: WidgetLabels;
			icons?: Partial<Record<ConnectKind, string>>;
		};
		status.setAttribute('variant', 'row');
		status.labels = this.labels;
		status.icons = this.#icons;
		status.store = this.#store;

		const act = (key: string, onclick: () => void): HTMLElement =>
			h(
				'button',
				{ part: 'button', type: 'button', disabled: this.#busy ? '' : null, onclick },
				this.t(key)
			);

		put(
			into,
			this.heading('destination-heading', 'destination.heading'),
			h(
				'div',
				{ part: 'card destination-card' },
				icon ? h('img', { part: 'icon', src: icon, alt: '' }) : null,
				h(
					'div',
					{},
					h('div', { part: 'title' }, title),
					sub ? h('div', { part: 'sub' }, sub) : null,
					encrypted ? h('div', { part: 'sub' }, this.t('destination.encrypted')) : null
				)
			),
			status,
			h(
				'div',
				{ part: 'destination-actions' },
				act('destination.export', () => void this.exportCopy()),
				// The library holds no records, so loading a copy back is the host's
				// own gesture - see the note at the top of this file.
				act('destination.restore', () =>
					this.emit('selfstore-destination-action', { action: 'restore' })
				),
				this.#targets
					? act('destination.change', () => {
							this.#changing = true;
							this.rerender();
						})
					: null,
				act('destination.detach', () => void this.detach(label))
			),
			this.#message
				? h('div', { part: 'sub destination-message', role: 'status' }, this.#message)
				: null
		);
	}
}
