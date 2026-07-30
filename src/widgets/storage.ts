/**
 * <selfstore-storage>: the whole storage journey, in one element.
 *
 *   const store = await selfstore('app', { drive: { clientId } });
 *   document.querySelector('selfstore-storage').store = store;
 *
 * That is the integration. Everything else is derived from the store: which
 * destinations to offer, which backup to propose reopening, who holds it.
 *
 * Why it exists. The pieces were all here - <selfstore-gate> before there is a
 * home, <selfstore-destination> once there is one - but assembling them was
 * left to every app, and the assembly is where the mistakes were: showing the
 * gate while the store was still loading, offering destinations built by hand
 * from the session the store already had, deriving the "reopen my backup" card
 * from data the library was holding. An app that mounted this element could not
 * have made any of them.
 *
 * It composes rather than redraws: the gate and the panel are the same elements
 * a host can still mount separately, with every knob they already had. What is
 * added here is only the CHOICE between them, which follows the engine's own
 * status - the same signal the gate uses to decide whether to be on screen.
 */

import type { ConnectTargets, FlowHost, StoreLike } from '../flows/connect';
import type { BackupsManager } from '../backups/manager';
import type { ConnectKind } from '../flows/connect';
import type { DestinationAction } from './destination';
import { FlowWidget, hostOf, put, siblingTag, type WidgetLabels } from './base';

/** What a simple store answers about its own destinations, when it is one. */
interface StoreWithOffers {
	destinations?: () => ConnectTargets;
	resumeOffer?: () => unknown;
	account?: string | null;
}

export class SelfstoreStorageElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['deferrable', 'recommended'];
	}

	#store: StoreLike | null = null;
	#targets: ConnectTargets | null = null;
	#manager: BackupsManager | null = null;
	#icons: Partial<Record<ConnectKind, string>> = {};
	#confirm: ((a: DestinationAction) => boolean | Promise<boolean>) | null = null;
	#deferrable = true;
	#recommended: ConnectKind | null = null;
	/** The child currently on screen, kept across renders: rebuilding a widget
	 *  mid-journey destroys the flow it is running. */
	#child: HTMLElement | null = null;
	#childKind: 'gate' | 'destination' | null = null;

	protected defaults(): WidgetLabels {
		// Every string belongs to the composed widgets; this one owns no copy.
		return {};
	}

	/** The store. A simple store answers `destinations()`, `resumeOffer()` and
	 *  `account` on its own, and then nothing else needs setting. */
	get store(): StoreLike | null {
		return this.#store;
	}
	set store(v: StoreLike | null) {
		if (v === this.#store) return;
		this.#store = v;
		this.#child = null;
		this.#childKind = null;
		this.follow(hostOf(v));
	}

	/** Override the destinations offered. Absent: whatever the store offers. */
	get targets(): ConnectTargets | null {
		return this.#targets;
	}
	set targets(v: ConnectTargets | null) {
		this.#targets = v;
		this.rerender();
	}

	/** The backups list, when this app manages several backup files. Absent: the
	 *  panel shows the destination alone. */
	get manager(): BackupsManager | null {
		return this.#manager;
	}
	set manager(v: BackupsManager | null) {
		this.#manager = v;
		this.rerender();
	}

	get icons(): Partial<Record<ConnectKind, string>> {
		return this.#icons;
	}
	set icons(v: Partial<Record<ConnectKind, string>> | null) {
		this.#icons = v ?? {};
		this.rerender();
	}

	/** Veto on what is destructive, handed to the destination panel. */
	get confirmAction(): ((a: DestinationAction) => boolean | Promise<boolean>) | null {
		return this.#confirm;
	}
	set confirmAction(fn: ((a: DestinationAction) => boolean | Promise<boolean>) | null) {
		this.#confirm = fn;
	}

	/** Whether the first-run screen offers the device-only way out. */
	get deferrable(): boolean {
		return this.#deferrable;
	}
	set deferrable(v: boolean) {
		this.#deferrable = v;
		this.rerender();
	}

	/** Which destination the first-run screen badges as recommended. */
	get recommended(): ConnectKind | null {
		return this.#recommended;
	}
	set recommended(v: ConnectKind | null) {
		this.#recommended = v;
		this.rerender();
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'deferrable') this.deferrable = value !== 'false';
		if (name === 'recommended') this.recommended = value as ConnectKind | null;
	}

	connectedCallback(): void {
		super.connectedCallback();
		if (this.hasAttribute('deferrable'))
			this.deferrable = this.getAttribute('deferrable') !== 'false';
		if (this.hasAttribute('recommended'))
			this.recommended = this.getAttribute('recommended') as ConnectKind;
		this.follow(hostOf(this.#store));
	}

	private host(): FlowHost | null {
		return hostOf(this.#store);
	}

	/** What the store offers, unless the host said otherwise. */
	private offers(): ConnectTargets {
		if (this.#targets) return this.#targets;
		const s = this.#store as StoreWithOffers | null;
		return s?.destinations?.() ?? { file: true };
	}

	protected view(into: HTMLElement): void {
		const host = this.host();
		if (!host) return; // inert until wired
		// The gate owns "should this be on screen at all" - including waiting for
		// the store to be ready. Reading the same signal here keeps ONE rule.
		const { ready, status } = host.engine.state;
		const wanted = !ready || status.action === 'choose-destination' ? 'gate' : 'destination';

		if (this.#childKind !== wanted || !this.#child) {
			this.#child = document.createElement(siblingTag(this.localName, 'storage', wanted));
			this.#childKind = wanted;
		}
		const el = this.#child as HTMLElement & Record<string, unknown>;
		el.labels = this.labels;
		el.icons = this.#icons;
		if (wanted === 'gate') {
			el.deferrable = this.#deferrable;
			el.recommended = this.#recommended;
			const resume = (this.#store as StoreWithOffers | null)?.resumeOffer?.();
			if (resume) el.options = { resume };
			el.targets = this.offers();
		} else {
			el.targets = this.offers();
			el.account = (this.#store as StoreWithOffers | null)?.account ?? null;
			el.confirmAction = this.#confirm;
		}
		// Last, always: assigning the store is what opens a gate, and it must read
		// its destinations first.
		el.store = this.#store;

		const list =
			wanted === 'destination' && this.#manager
				? Object.assign(document.createElement(siblingTag(this.localName, 'storage', 'backups')), {
						labels: this.labels,
						manager: this.#manager
					})
				: null;
		put(into, el, list);
	}
}
