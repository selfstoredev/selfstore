// <selfstore-status>: the store's save status. Renders the engine's own
// StatusDescriptor - the widget never invents a state. variant="row" is a
// severity dot + status line + one action button (settings panel, menu);
// variant="dot" is just the dot as an aria-labelled button (header corner).
// An actionable status emits 'selfstore-status-action' with the suggested
// action; what it means (open settings, run reconnect) is the host's call.

import type { FlowHost } from '../flows/connect';
import { FlowWidget, h, put, type WidgetLabels } from './base';

const EN: WidgetLabels = {
	'status.ephemeral': 'Nothing is saved',
	'status.cacheOnly': 'Only on this device',
	'status.saving': 'Saving...',
	'status.saved': 'Saved',
	'status.needsAttention': 'Reconnect to continue',
	'status.locked': 'Locked',
	'status.pendingDownload': 'Changes to download',
	'status.action.choose-destination': 'Choose a destination',
	'status.action.download': 'Download',
	'status.action.reconnect': 'Reconnect',
	'status.action.unlock': 'Unlock'
};

export class SelfstoreStatusElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['variant'];
	}

	#store: FlowHost | { flowHost: FlowHost } | null = null;
	#variant: 'row' | 'dot' = 'row';
	#icons: Record<string, string> = {};

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
		const text = this.t(status.labelKey);
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
