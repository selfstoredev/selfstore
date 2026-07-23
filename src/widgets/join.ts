/**
 * <selfstore-join>: opening an invitation link, ready to drop in. A skin over
 * joinFlow: preview first, join on an explicit yes, named outcomes (already
 * following another share / invite spent) instead of generic errors, and the
 * account switch as part of the journey when the engine offers one.
 *
 *   el.link = location.href;   // or the link attribute
 *   el.engine = myJoinEngine;
 *   el.addEventListener('selfstore-joined', () => goHome());
 *
 * variant="banner" collapses the invitation card to a one-line row (label,
 * join, account switch) for pages that render their own preview around it.
 */

import { joinFlow, type JoinEngine, type JoinFlow } from '../flows/join';
import { FlowWidget, h, put, type WidgetLabels } from './base';

const EN: WidgetLabels = {
	'join.previewing': 'Reading the invitation...',
	'join.title': 'You are invited',
	'join.from': 'Shared by {from}',
	'join.level.read': 'You will be able to view it.',
	'join.level.write': 'You will be able to view and edit it.',
	'join.accept': 'Join',
	'join.joining': 'Joining...',
	'join.joined': 'You are in. The shared data now syncs on this device.',
	'join.mismatch':
		'This device already follows another share. Leave it first, or use another profile.',
	'join.noInvite': 'This invitation is spent, or meant for another account.',
	'join.switchAccount': 'Use another account',
	'join.retry': 'Try again',
	'error.generic': 'That did not work. Check the connection and try again.',
	'error.targetUnavailable': 'The invitation could not be read. Try again in a moment.'
};

export class SelfstoreJoinElement extends FlowWidget {
	static get observedAttributes(): string[] {
		return ['link', 'variant'];
	}

	#engine: JoinEngine | null = null;
	#link: string | null = null;
	#flow: JoinFlow | null = null;
	#variant: 'card' | 'banner' = 'card';
	#options: { deadlineMs?: number } = {};

	protected defaults(): WidgetLabels {
		return EN;
	}

	get engine(): JoinEngine | null {
		return this.#engine;
	}
	set engine(v: JoinEngine | null) {
		this.#engine = v;
		this.wire();
	}

	/** The invitation. Also settable as the `link` attribute. */
	get link(): string | null {
		return this.#link;
	}
	set link(v: string | null) {
		this.#link = v;
		this.wire();
	}

	/** Flow options (deadlineMs). Set it when the engine's join opens a popup:
	 *  a generous deadline keeps the network guard without timing out a human
	 *  who is reading an account chooser. */
	get options(): { deadlineMs?: number } {
		return this.#options;
	}
	set options(v: { deadlineMs?: number } | null) {
		this.#options = v ?? {};
		this.wire();
	}

	/** 'card' (default): the full invitation card - who shared, what level.
	 *  'banner': one line - label, join, account switch - for a host page that
	 *  renders its own preview around the widget. Also the `variant` attribute. */
	get variant(): 'card' | 'banner' {
		return this.#variant;
	}
	set variant(v: 'card' | 'banner') {
		this.#variant = v === 'banner' ? 'banner' : 'card';
		this.rerender();
	}

	get flow(): JoinFlow | null {
		return this.#flow;
	}

	attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
		if (name === 'link') this.link = value;
		if (name === 'variant') this.variant = (value ?? 'card') as 'card' | 'banner';
	}

	connectedCallback(): void {
		if (!this.#link && this.hasAttribute('link')) this.#link = this.getAttribute('link');
		if (this.hasAttribute('variant')) {
			this.#variant = this.getAttribute('variant') === 'banner' ? 'banner' : 'card';
		}
		this.wire();
	}

	private wire(): void {
		if (!this.isConnected || !this.#engine || !this.#link) return;
		this.unsub?.();
		this.#flow = joinFlow(this.#link, this.#engine, this.#options);
		let lastStep: string | null = null;
		this.unsub = this.#flow.subscribe((snap) => {
			if (snap.step !== lastStep) {
				if (snap.step === 'joined') this.emit('selfstore-joined', { outcome: 'joined' });
				if (snap.step === 'mismatch' || snap.step === 'no-invite') {
					this.emit('selfstore-join-refused', { outcome: snap.step });
				}
				if (snap.step === 'ready' && lastStep === 'joining') {
					// join() answered null: the user backed out of the engine's popup.
					this.emit('selfstore-cancelled');
				}
				lastStep = snap.step;
			}
			this.rerender();
		});
	}

	protected view(into: HTMLElement): void {
		const flow = this.#flow;
		if (!flow) return;
		const s = flow.snapshot;

		if (s.step === 'previewing' || s.step === 'joining') {
			into.append(
				h(
					'div',
					{ part: 'status' },
					h('span', { part: 'spinner', 'aria-hidden': 'true' }),
					h(
						'div',
						{ part: 'title' },
						this.t(s.step === 'joining' ? 'join.joining' : 'join.previewing')
					)
				)
			);
			return;
		}

		if (s.step === 'ready') {
			const p = s.preview;
			if (this.#variant === 'banner') {
				put(
					into,
					h(
						'div',
						{ part: 'row banner' },
						h(
							'div',
							{ part: 'title', style: 'flex:1;min-width:0' },
							p?.label || this.t('join.title')
						),
						h(
							'button',
							{
								part: 'button button-primary',
								'data-action': 'accept',
								onclick: () => flow.accept()
							},
							this.t('join.accept')
						),
						s.canSwitchAccount
							? h(
									'button',
									{ part: 'link', 'data-action': 'switch', onclick: () => flow.switchAccount() },
									this.t('join.switchAccount')
								)
							: null
					)
				);
				return;
			}
			put(
				into,
				h('div', { part: 'title' }, p?.label || this.t('join.title')),
				p?.from ? h('div', { part: 'sub' }, this.t('join.from').replace('{from}', p.from)) : null,
				p?.level ? h('div', { part: 'hint' }, this.t(`join.level.${p.level}`)) : null,
				h(
					'div',
					{ part: 'row' },
					h(
						'button',
						{
							part: 'button button-primary',
							'data-action': 'accept',
							onclick: () => flow.accept()
						},
						this.t('join.accept')
					),
					s.canSwitchAccount
						? h(
								'button',
								{ part: 'link', 'data-action': 'switch', onclick: () => flow.switchAccount() },
								this.t('join.switchAccount')
							)
						: null
				)
			);
			return;
		}

		if (s.step === 'joined') {
			into.append(
				h('div', { part: 'status status-ok' }, h('div', { part: 'title' }, this.t('join.joined')))
			);
			return;
		}

		if (s.step === 'mismatch' || s.step === 'no-invite') {
			into.append(
				h(
					'div',
					{ part: 'status' },
					h(
						'div',
						{ part: 'title' },
						this.t(s.step === 'mismatch' ? 'join.mismatch' : 'join.noInvite')
					)
				)
			);
			if (s.step === 'no-invite' && s.canSwitchAccount) {
				into.append(
					h(
						'div',
						{ part: 'row' },
						h(
							'button',
							{ part: 'button', 'data-action': 'switch', onclick: () => flow.switchAccount() },
							this.t('join.switchAccount')
						)
					)
				);
			}
			return;
		}

		// error
		into.append(
			h(
				'div',
				{ part: 'status status-error' },
				h('div', { part: 'title' }, this.errorText(s.error?.labelKey))
			),
			h(
				'div',
				{ part: 'row' },
				h('button', { part: 'button', onclick: () => flow.retry() }, this.t('join.retry')),
				s.canSwitchAccount
					? h(
							'button',
							{ part: 'link', 'data-action': 'switch', onclick: () => flow.switchAccount() },
							this.t('join.switchAccount')
						)
					: null
			)
		);
	}
}
