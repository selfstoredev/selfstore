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

import type { ConnectKind, ConnectTargets, StoreLike } from '../flows/connect';
import { datedName, saveToDisk } from '../selfstore/targets/local';
import { FlowWidget, h, put, siblingTag, type WidgetLabels } from './base';
import { EN as KIND_EN, FR as KIND_FR } from './kinds';

/** What the panel is about to do, for the host's veto. */
export interface DestinationAction {
	type: 'detach';
	/** The destination's own name, when it has one. */
	label: string | null;
}

const EN: WidgetLabels = {
	...KIND_EN,
	'destination.heading': 'Where your data is kept',
	'destination.encrypted': 'Password-protected',
	'destination.active': 'Active',
	'destination.reach.drive': 'On all your devices',
	'destination.reach.file': '',
	'destination.export': 'Export a copy',
	'destination.exported': 'The copy is written.',
	'destination.exportCancelled': 'Nothing was written.',
	'destination.restore': 'Restore a copy',
	'destination.change': 'Change backup',
	'destination.detach': 'Stop saving here',
	'destination.detached': 'Stopped. Your data stays on this device.',
	'destination.back': 'Back',
	'error.generic': 'Something went wrong.'
};

// One verb per gesture, and the precious thing is never the object of the verb:
// "ne plus enregistrer ici" says what stops, where "detacher cette sauvegarde"
// would read as taking the backup away.
//
// A pack carries only what READS differently: `t()` falls back to the EN
// defaults, so a key repeated word for word (a brand name) would just be a
// second place to keep it in step.
const FR: WidgetLabels = {
	...KIND_FR,
	'destination.heading': 'Où vos données sont enregistrées',
	'destination.encrypted': 'Protégée par un mot de passe',
	'destination.active': 'Active',
	'destination.reach.drive': 'Sur tous vos appareils',
	'destination.reach.file': '',
	'destination.export': 'Exporter une copie',
	'destination.exported': 'La copie est écrite.',
	'destination.exportCancelled': "Rien n'a été écrit.",
	// "Restaurer", pas "charger" : le premier dit qu'on REVIENT a un etat, le
	// second pourrait ajouter. Face a "Exporter une copie", la paire se lit
	// comme l'aller-retour qu'elle est.
	'destination.restore': 'Restaurer une copie',
	'destination.change': 'Changer de sauvegarde',
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

export class SelfstoreDestinationElement extends FlowWidget {
	#targets: ConnectTargets | null = null;
	#account: string | null = null;
	#confirm: ((a: DestinationAction) => boolean | Promise<boolean>) | null = null;
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
		this.follow(this.hostOf());
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
		const host = this.hostOf();
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
		const host = this.hostOf();
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

	protected view(into: HTMLElement): void {
		const host = this.hostOf();
		if (!host) return; // inert until wired
		const { targetKind, label, encrypted } = host.engine.state;
		const kind = this.t(`destination.kind.${targetKind}`);
		// An unknown kind (a host's own target) has no shipped name: its own label
		// is a better answer than the raw key.
		const title = kind === `destination.kind.${targetKind}` ? (label ?? targetKind) : kind;
		// Who holds it. An address identifies a destination better than the backup
		// file inside it does, so the file name gives way when there is one - it is
		// on the status line above either way.
		const sub = this.#account || (label && label !== title ? label : null);
		const icon = this.icons[targetKind as ConnectKind];
		const status = document.createElement(
			siblingTag(this.localName, 'destination', 'status')
		) as HTMLElement & {
			store?: StoreLike | null;
			labels?: WidgetLabels;
			icons?: Partial<Record<ConnectKind, string>>;
		};
		status.setAttribute('variant', 'row');
		status.labels = this.labels;
		status.icons = this.icons;
		status.store = this.store;

		// An empty-string label removes the gesture, the same convention as the
		// headings: labels = { 'destination.detach': '' } is how a host that
		// forbids the device-only state takes that journey off the screen. Each
		// button also carries its own part, so a host can style or hide ONE of
		// them from CSS - four gestures sharing one anonymous part made the row
		// impossible to prune, which is how a panel ends up "too many buttons".
		const act = (key: string, part: string, onclick: () => void): HTMLElement | null => {
			const label = this.t(key);
			if (!label) return null;
			return h(
				'button',
				{ part: `button ${part}`, type: 'button', disabled: this.#busy ? '' : null, onclick },
				label
			);
		};

		// Where this backup reaches, which is the whole reason one destination is
		// picked over another - and the one thing the destination's own name does
		// not say. Unknown kinds simply have no line.
		const durable = targetKind !== 'device' && targetKind !== 'ephemeral';
		const reach = this.t(`destination.reach.${targetKind}`);
		const line = [sub, reach === `destination.reach.${targetKind}` ? null : reach]
			.filter(Boolean)
			.join(' · ');
		put(
			into,
			// The situation first, then what holds it: a panel that opens on a card
			// makes the reader work out from the name whether anything is wrong.
			status,
			this.heading('destination-heading', 'destination.heading'),
			h(
				'div',
				{ part: 'card destination-card' },
				icon ? h('img', { part: 'icon', src: icon, alt: '' }) : null,
				h(
					'div',
					{},
					h(
						'div',
						{ part: 'title' },
						title,
						// Only where there IS a backup: "Active" over the device-only
						// state would badge the absence of one as a live destination.
						durable
							? h('span', { part: 'tag destination-active' }, this.t('destination.active'))
							: null,
						encrypted
							? h('span', { part: 'tag destination-encrypted' }, this.t('destination.encrypted'))
							: null
					),
					line ? h('div', { part: 'sub' }, line) : null
				)
			),
			h(
				'div',
				{ part: 'destination-actions' },
				act('destination.export', 'destination-export', () => void this.exportCopy()),
				// The library holds no records, so loading a copy back is the host's
				// own gesture - see the note at the top of this file.
				act('destination.restore', 'destination-restore', () =>
					this.emit('selfstore-destination-action', { action: 'restore' })
				),
				// Changing backup lets the destination go and stops there: the
				// first-run screen the app already mounts is what asks where to go
				// next. A second connect journey inside this panel gave the same
				// decision two mechanics depending on which control was pressed, and
				// only one of them could be reached from anywhere in the app.
				this.#targets
					? act('destination.change', 'destination-change', () => void this.detach(label))
					: null,
				act('destination.detach', 'destination-detach', () => void this.detach(label))
			),
			this.#message
				? h('div', { part: 'sub destination-message', role: 'status' }, this.#message)
				: null
		);
	}
}
