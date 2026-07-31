/**
 * <selfstore-account>: the storage control in an app's chrome.
 *
 *   document.querySelector('selfstore-account').store = store;
 *
 * A trigger that states where the data is going, and a short menu that answers
 * the two questions a header should answer: WHO holds my backup and when was
 * it last written, and how do I change my mind.
 *
 * Why it is short. The panel (<selfstore-destination>) offers four gestures,
 * which is right for a settings page and wrong for a menu: a header that opens
 * onto "export a copy / restore a copy / change backup / stop saving here"
 * asks the user to arbitrate between four irreversible-looking words before
 * they know what any of them does. So this element keeps exactly two - go to
 * the settings, where the panel lives, or change backup - and hands the rest
 * to the page the host already has.
 *
 * "Change backup" detaches, and stops there. It does not run a connect journey
 * of its own: an app that mounts <selfstore-gate> (or <selfstore-storage>)
 * already has the first-run screen, and a store with no destination is exactly
 * what that screen is for. One journey, reached the same way whether it is the
 * first day or a change of mind.
 */

import type { ConnectKind, FlowHost, StoreLike } from '../flows/connect';
import type { DestinationAction } from './destination';
import { FlowWidget, h, put, siblingTag, type WidgetLabels } from './base';
import { EN as KIND_EN, FR as KIND_FR } from './kinds';

const EN: WidgetLabels = {
	...KIND_EN,
	'account.open': 'Storage',
	'account.settings': 'Settings',
	'account.change': 'Change backup',
	'account.saved': 'Saved {when}',
	'account.justNow': 'just now',
	'error.generic': 'Something went wrong.'
};

// "Changer de sauvegarde" is the same words as the panel's, on purpose: the
// two controls run the same journey, so they must not read as two.
const FR: WidgetLabels = {
	...KIND_FR,
	'account.open': 'Sauvegarde',
	'account.settings': 'Paramètres',
	'account.change': 'Changer de sauvegarde',
	'account.saved': 'Enregistré {when}',
	'account.justNow': "à l'instant",
	'error.generic': "Quelque chose n'a pas fonctionné."
};

// A menu floats OVER the page, so it has to be opaque, and it cannot borrow
// the page's background the way the rest of a widget borrows its font: there
// is nothing behind it to borrow. `Canvas` is the system surface (it follows
// light and dark on its own); a host with a paper of its own sets
// --selfstore-surface once and both are covered.
const ACCOUNT_STYLES = `
:host { position: relative; display: inline-block; }
/* Every other widget fills the width it is given, so the shared stack declares
   itself a size container (that is what lets a card lay out against ITS width
   and not the page's). This one is a control in a header: it must be as wide as
   its own label. Inline-size containment makes a box report an intrinsic width
   of ZERO - the pill collapsed to its dot in a flex header, with the label
   overflowing off screen. Nothing here queries its own width. */
[part~='stack'] { container-type: normal; display: block; }
[part~='account-trigger'] {
	display: inline-flex;
	align-items: center;
	gap: 0.4rem;
	max-width: 22rem;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font: inherit;
	color: inherit;
	background: transparent;
	border: 1px solid var(--_border);
	border-radius: 999px;
	padding: 0.3rem 0.7rem;
	cursor: pointer;
}
[part~='account-dot'] {
	width: 0.5rem;
	height: 0.5rem;
	border-radius: 50%;
	background: currentColor;
	flex: none;
}
[part~='account-menu'] {
	position: absolute;
	right: 0;
	top: calc(100% + 0.4rem);
	z-index: 20;
	min-width: min(17rem, calc(100vw - 2rem));
	max-width: min(24rem, calc(100vw - 2rem));
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 0.25rem;
	text-align: start;
	padding: 0.4rem;
	background: var(--selfstore-surface, Canvas);
	box-shadow: var(--selfstore-shadow, 0 10px 30px rgb(0 0 0 / 0.14));
}
[part~='account-card'] {
	display: flex;
	align-items: flex-start;
	gap: 0.6rem;
	width: 100%;
	font: inherit;
	color: inherit;
	text-align: start;
	background: transparent;
	border: none;
	border-radius: calc(var(--_radius) * 0.75);
	padding: 0.5rem 0.6rem;
	cursor: pointer;
}
[part~='account-card']:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
[part~='account-logo'] { width: 1.4rem; height: 1.4rem; object-fit: contain; flex: none; }
[part~='account-text'] {
	display: flex;
	flex-direction: column;
	gap: 0.15rem;
	min-width: 0;
	line-height: 1.35;
}
[part~='account-title'] {
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
/* An address is long and its END is the part that identifies it, so it gets a
   line of its own and an ellipsis rather than a wrap that pushes the status
   line out of the card. */
[part~='account-mail'], [part~='account-line'] {
	font-size: 0.8125rem;
	color: var(--_ink-dim);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
/* A menu item is a plain line of text, not a link: underlined blue links in a
   menu read as four different destinations to weigh, which is exactly the
   feeling this menu exists to remove. */
[part~='account-item'] {
	text-align: start;
	padding: 0.5rem 0.55rem;
	border: none;
	background: none;
	border-radius: calc(var(--_radius) * 0.75);
	font: inherit;
	font-size: 0.8125rem;
	text-decoration: none;
	color: inherit;
	cursor: pointer;
	white-space: nowrap;
}
[part~='account-item']:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
/* Letting a destination go is the one gesture here that takes something away:
   it wears the colour every other screen uses for that, and nothing else does. */
[part~='account-change'] { color: var(--_danger); }
[part~='account-change']:hover { background: color-mix(in srgb, var(--_danger) 10%, transparent); }
[part~='account-sep'] { height: 1px; background: var(--_border); margin: 0.2rem 0.3rem; }
[part~='account-error'] { margin: 0.15rem 0.55rem 0.3rem; font-size: 0.8125rem; color: var(--_danger); }
`;

/** How long a "saved just now" stays true, and the beat at which the open menu
 *  re-reads its own clock. A line that says "just now" ten minutes later is
 *  the same lie as a status that never updates. */
const TICK_MS = 30_000;

export class SelfstoreAccountElement extends FlowWidget {
	#confirm: ((a: DestinationAction) => boolean | Promise<boolean>) | null = null;
	#open = false;
	#error: string | null = null;
	#timer: ReturnType<typeof setInterval> | null = null;
	#away: ((e: Event) => void) | null = null;

	protected defaults(): WidgetLabels {
		return EN;
	}

	protected packs(): Record<string, WidgetLabels> {
		return { fr: FR };
	}

	constructor() {
		super();
		this.root.append(h('style', {}, ACCOUNT_STYLES));
	}

	/** Who holds the backup ("someone@example.com"). Absent: whatever the store
	 *  knows. A brand name is not an address, and several accounts look alike. */
	#account: string | null = null;
	get account(): string | null {
		return this.#account ?? (this.store as { account?: string | null } | null)?.account ?? null;
	}
	set account(v: string | null) {
		this.#account = v || null;
		this.rerender();
	}

	/** Veto on changing backup, which leaves the app with no destination until
	 *  the user picks one. Returns false (or throws) to stop. */
	get confirmAction(): ((a: DestinationAction) => boolean | Promise<boolean>) | null {
		return this.#confirm;
	}
	set confirmAction(fn: ((a: DestinationAction) => boolean | Promise<boolean>) | null) {
		this.#confirm = fn;
	}

	/** Whether the menu is on screen. Settable, so a host can close it from its
	 *  own router after the settings item navigated away. */
	get open(): boolean {
		return this.#open;
	}
	set open(v: boolean) {
		if (v === this.#open) return;
		this.#open = v;
		this.watch();
		this.rerender();
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.follow(this.hostOf());
	}

	disconnectedCallback(): void {
		this.unsub?.();
		this.unsub = null;
		this.#open = false;
		this.watch();
	}

	/** While the menu is open: a clock for the relative time, and the two ways
	 *  out that make it a menu rather than a page - a click anywhere else, and
	 *  Escape. `pointerdown` and not `click`, so the gesture that closes it does
	 *  not also land on whatever was under the menu. Shadow DOM retargets the
	 *  event, so what is asked is the composed path, never `e.target`. */
	private watch(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		if (this.#away) {
			document.removeEventListener('pointerdown', this.#away, true);
			document.removeEventListener('keydown', this.#away, true);
			this.#away = null;
		}
		if (!this.#open || !this.isConnected) return;
		this.#timer = setInterval(() => this.rerender(), TICK_MS);
		this.#away = (e: Event): void => {
			if (e instanceof KeyboardEvent) {
				if (e.key === 'Escape') this.open = false;
				return;
			}
			if (!e.composedPath().includes(this)) this.open = false;
		};
		document.addEventListener('pointerdown', this.#away, true);
		document.addEventListener('keydown', this.#away, true);
	}

	/** The destination's name. An unknown kind (a host's own target) has no
	 *  shipped name: its own label is a better answer than the raw key. */
	private named(host: FlowHost): string {
		const { targetKind, label } = host.engine.state;
		const kind = this.t(`destination.kind.${targetKind}`);
		return kind === `destination.kind.${targetKind}` ? (label ?? targetKind) : kind;
	}

	/**
	 * The one line under the account. A plain "saved" is the only state this
	 * element words itself, because it is the only one with nothing to do about
	 * it - and the only one where WHEN is the whole information. Everything else
	 * (reconnect, unlock, changes to download) belongs to <selfstore-status>,
	 * which owns both the wording and the button that resolves it.
	 */
	private line(host: FlowHost): HTMLElement {
		const { status, lastSavedAt } = host.engine.state;
		if (status.state === 'saved' && lastSavedAt && !('status.saved' in this.labels))
			return h(
				'span',
				{ part: 'account-line' },
				this.t('account.saved', { when: this.since(lastSavedAt, this.t('account.justNow')) })
			);
		const el = document.createElement(
			siblingTag(this.localName, 'account', 'status')
		) as HTMLElement & {
			store?: StoreLike | null;
			labels?: WidgetLabels;
			icons?: Partial<Record<ConnectKind, string>>;
		};
		el.setAttribute('variant', 'row');
		el.labels = this.labels;
		el.icons = this.icons;
		el.store = this.store;
		return el;
	}

	/** Ask for the settings. The host owns the route, so this only says that it
	 *  was asked - and closes, because a menu that stays open behind a page
	 *  transition reads as a failed click. */
	private settings(): void {
		this.open = false;
		this.emit('selfstore-account-settings');
	}

	/** Change backup: detach, and let the first-run screen take it from there.
	 *  The data stays; only the destination is let go. */
	private async change(): Promise<void> {
		const host = this.hostOf();
		if (!host) return;
		this.open = false;
		this.#error = null;
		const label = host.engine.state.label;
		// A throwing hook reads as "no": changing backup is a decision, and an
		// undecided answer must not be taken for a yes.
		try {
			if (this.#confirm && !(await this.#confirm({ type: 'detach', label }))) return;
		} catch {
			return;
		}
		try {
			await host.engine.detachTarget();
		} catch {
			// A failure that closed the menu behind it is indistinguishable from a
			// button that does nothing. It is said where the press happened, and
			// the menu reopens to carry it.
			this.#error = this.t('error.generic');
			this.open = true;
			this.rerender();
		}
	}

	private card(host: FlowHost): HTMLElement {
		const { targetKind } = host.engine.state;
		const icon = this.icons[targetKind as ConnectKind];
		const mail = this.account;
		return h(
			'button',
			{
				part: 'account-card',
				type: 'button',
				role: 'menuitem',
				title: this.t('account.settings'),
				onclick: () => this.settings()
			},
			icon ? h('img', { part: 'account-logo', src: icon, alt: '' }) : null,
			h(
				'span',
				{ part: 'account-text' },
				h('span', { part: 'account-title' }, this.named(host)),
				mail ? h('span', { part: 'account-mail' }, mail) : null,
				this.line(host)
			)
		);
	}

	protected view(into: HTMLElement): void {
		const host = this.hostOf();
		if (!host) return; // inert until wired
		const { status } = host.engine.state;
		const trigger = h(
			'button',
			{
				part: `account-trigger ${status.severity}`,
				type: 'button',
				'aria-haspopup': 'menu',
				'aria-expanded': String(this.#open),
				'aria-label': this.t('account.open'),
				onclick: () => (this.open = !this.#open)
			},
			// The severity colors the DOT, never the label: a whole line turning
			// amber reads as a warning about the destination's name.
			h('span', { part: `account-dot sev-${status.severity}` }),
			h('span', {}, this.named(host))
		);
		const menu = this.#open
			? h(
					'div',
					{ part: 'card account-menu', role: 'menu' },
					this.card(host),
					h('div', { part: 'account-sep' }),
					h(
						'button',
						{
							part: 'account-item',
							type: 'button',
							role: 'menuitem',
							onclick: () => this.settings()
						},
						this.t('account.settings')
					),
					h(
						'button',
						{
							part: 'account-item account-change',
							type: 'button',
							role: 'menuitem',
							onclick: () => void this.change()
						},
						this.t('account.change')
					),
					this.#error ? h('p', { part: 'account-error', role: 'alert' }, this.#error) : null
				)
			: null;
		put(into, trigger, menu);
		if (menu) this.anchor(menu);
	}

	/**
	 * Which side the menu hangs from.
	 *
	 * A header control is usually at the right edge, so the menu hangs right -
	 * and the moment the header wraps on a narrow window, that same control sits
	 * at the LEFT edge and the menu hangs off the screen. Measured rather than
	 * assumed: it hangs left when there is room to the right, and right
	 * otherwise, which lands correctly at both edges without the host declaring
	 * where it put the control.
	 */
	private anchor(menu: HTMLElement): void {
		const here = this.getBoundingClientRect();
		const fits = here.left + menu.getBoundingClientRect().width <= window.innerWidth - 8;
		menu.style.left = fits ? '0' : 'auto';
		menu.style.right = fits ? 'auto' : '0';
	}
}
