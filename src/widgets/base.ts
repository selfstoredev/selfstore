// Shared foundation for the widgets: zero-dependency custom elements over
// the headless flows. Look and words stay the host's business through three
// layers - --selfstore-* custom properties (fonts and text colors inherit),
// part="..." on every significant node, and a flat `labels` map merged over
// the EN defaults (also the localization story). Elements are inert until
// wired: assign the properties, the widget builds its flow and renders; they
// clean up on disconnect and expose the flow for programmatic control.

/** Flat key -> string map; widgets merge a partial override over EN defaults. */
export type WidgetLabels = Record<string, string>;

/** Structural theme, applied inside every widget's shadow root. Neutral by
 *  design: it borrows the host font and text color, and every visual decision
 *  routes through a --selfstore-* custom property a host page can set. */
export const baseStyles = `
:host {
	display: block;
	font: inherit;
	color: inherit;
	--_accent: var(--selfstore-accent, #2563eb);
	--_accent-ink: var(--selfstore-accent-contrast, #ffffff);
	--_ink-dim: var(--selfstore-muted, color-mix(in srgb, currentColor 55%, transparent));
	--_border: var(--selfstore-border, color-mix(in srgb, currentColor 16%, transparent));
	--_radius: var(--selfstore-radius, 12px);
	--_gap: var(--selfstore-gap, 0.6rem);
	--_danger: var(--selfstore-danger, #dc2626);
	--_ok: var(--selfstore-ok, #16a34a);
	--_warn: var(--selfstore-warn, #d97706);
}
/* Status severity, as a text color the dot inherits (background: currentColor). */
[part~='sev-ok'] { color: var(--_ok); }
[part~='sev-info'] { color: var(--_accent); }
[part~='sev-warn'] { color: var(--_warn); }
[part~='sev-danger'] { color: var(--_danger); }
span[part~='status-dot'] {
	display: inline-block;
	width: 0.6em;
	height: 0.6em;
	border-radius: 50%;
	background: currentColor;
	flex-shrink: 0;
}
button[part~='dot-button'] {
	background: none;
	border: none;
	padding: 0.2em;
	cursor: pointer;
	line-height: 0;
}
[part~='status-row'] [part~='status-action'] { margin-left: auto; }
[part~='card'] {
	border: 1px solid var(--_border);
	border-radius: var(--_radius);
	padding: 0.8rem 0.9rem;
	display: flex;
	align-items: center;
	gap: var(--_gap);
	width: 100%;
	box-sizing: border-box;
	background: transparent;
	text-align: left;
}
button[part~='card'] { cursor: pointer; font: inherit; color: inherit; }
button[part~='card']:hover { border-color: var(--_accent); }
img[part~='icon'] {
	width: var(--selfstore-icon-size, 2.1em);
	height: var(--selfstore-icon-size, 2.1em);
	object-fit: contain;
	flex-shrink: 0;
}
[part~='stack'] { display: flex; flex-direction: column; gap: var(--_gap); container-type: inline-size; }
[part~='row'] { display: flex; align-items: center; gap: var(--_gap); flex-wrap: wrap; }
[part~='title'] { font-weight: 600; }
[part~='sub'], [part~='hint'] { color: var(--_ink-dim); font-size: 0.9em; }
[part~='tag'] {
	display: inline-block;
	font-size: 0.72em;
	font-weight: 600;
	line-height: 1.5;
	padding: 0 0.55em;
	margin-left: 0.5em;
	border-radius: 999px;
	background: var(--_accent);
	color: var(--_accent-ink);
	vertical-align: middle;
}
[part~='status'] {
	display: flex;
	align-items: center;
	gap: var(--_gap);
	padding: 0.7rem 0.9rem;
	border-radius: var(--_radius);
	background: color-mix(in srgb, var(--_accent) 10%, transparent);
}
[part~='status-ok'] { background: color-mix(in srgb, var(--_ok) 12%, transparent); }
[part~='status-error'] { background: color-mix(in srgb, var(--_danger) 12%, transparent); }
[part='spinner'] {
	width: 0.7em; height: 0.7em; flex-shrink: 0;
	border-radius: 50%;
	border: 2px solid var(--_accent);
	border-top-color: transparent;
	animation: ss-spin 0.8s linear infinite;
}
@keyframes ss-spin { to { transform: rotate(360deg); } }
button[part~='button'] {
	font: inherit;
	padding: 0.45rem 0.9rem;
	border-radius: calc(var(--_radius) * 0.75);
	border: 1px solid var(--_border);
	background: transparent;
	color: inherit;
	cursor: pointer;
}
button[part~='button']:disabled { opacity: 0.55; cursor: default; }
button[part~='button-primary'] {
	background: var(--_accent);
	border-color: var(--_accent);
	color: var(--_accent-ink);
}
button[part~='button-danger'] { color: var(--_danger); }
button[part~='link'] {
	font: inherit;
	background: none;
	border: none;
	padding: 0;
	color: var(--_ink-dim);
	text-decoration: underline;
	cursor: pointer;
}
button[part~='link']:disabled { opacity: 0.55; cursor: default; }
button[part~='link-danger'] { color: var(--_danger); }
button[part~='advanced-link'] {
	width: fit-content;
	font-size: 0.85em;
	margin-top: 0.1rem;
}
[part~='card'] [part~='row'] { margin-top: 0.45rem; }
input[part~='input'] {
	font: inherit;
	color: inherit;
	background: transparent;
	border: 1px solid var(--_border);
	border-radius: calc(var(--_radius) * 0.75);
	padding: 0.45rem 0.6rem;
	width: 100%;
	box-sizing: border-box;
}
input[part~='input']:focus { outline: 2px solid var(--_accent); outline-offset: 1px; }
/* A text input with a trailing button (the password eye) tucked inside it. */
[part~='field'] { position: relative; display: flex; align-items: center; width: 100%; }
[part~='field'] input[part~='input'] { padding-right: 2.4rem; }
button[part~='eye'] {
	position: absolute;
	right: 0.25rem;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2rem;
	height: 2rem;
	background: none;
	border: none;
	padding: 0;
	cursor: pointer;
	color: var(--_ink-dim);
}
button[part~='eye']:hover { color: inherit; }
button[part~='eye'] svg { width: 1.15em; height: 1.15em; display: block; }
[part~='warn-note'] { color: var(--_warn); }
button[part~='forgot-link'] { width: fit-content; font-size: 0.85em; margin-top: 0.15rem; }
[part~='error-note'] { color: var(--_danger); font-size: 0.9em; }
/* WebDAV/S3 segmented control: a rail with the inactive segments quiet and the
   active one lifted onto the surface. Full-width segments, equal share. */
[part~='tabs'] {
	display: flex;
	gap: 0.2rem;
	padding: 0.25rem;
	border-radius: calc(var(--_radius) * 0.7);
	background: color-mix(in srgb, currentColor 8%, transparent);
}
button[part~='tab'] {
	flex: 1 1 0;
	font: inherit;
	font-weight: 600;
	padding: 0.4rem 0.7rem;
	border: none;
	border-radius: calc(var(--_radius) * 0.5);
	background: transparent;
	color: var(--_ink-dim);
	cursor: pointer;
}
button[part~='tab']:hover { color: inherit; }
button[part~='tab-on'] {
	background: Canvas;
	color: inherit;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.08);
}
/* WebDAV provider quick-pick chips. */
[part~='presets'] { display: flex; flex-wrap: wrap; gap: 0.4rem; }
button[part~='preset'] {
	font: inherit;
	font-size: 0.85em;
	padding: 0.3rem 0.75rem;
	border: 1px solid var(--_border);
	border-radius: 999px;
	background: transparent;
	color: inherit;
	cursor: pointer;
}
button[part~='preset']:hover { border-color: var(--_accent); }
button[part~='preset-on'] {
	border-color: var(--_accent);
	background: color-mix(in srgb, var(--_accent) 12%, transparent);
}
ul[part~='list'] { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--_gap); }
img[part~='qr'] {
	width: var(--selfstore-qr-size, 6.5em);
	height: var(--selfstore-qr-size, 6.5em);
	border-radius: calc(var(--_radius) * 0.5);
	background: #ffffff;
	flex-shrink: 0;
}
/* Overflow menu. The trigger is a quiet in-card button; the open menu is a
   dropdown over the trigger's corner on wide screens and a bottom sheet on
   phones. The backdrop catches every outside click or tap (the standard
   dismiss), sitting above the sibling cards but under the panel. */
button[part~='menu-button'] {
	border: none;
	background: none;
	padding: 0.25rem 0.6rem;
	font-size: 1.1em;
	line-height: 1.3;
	border-radius: calc(var(--_radius) * 0.5);
	color: var(--_ink-dim);
	cursor: pointer;
}
button[part~='menu-button']:hover,
button[part~='menu-button'][aria-expanded='true'] {
	background: color-mix(in srgb, currentColor 10%, transparent);
	color: inherit;
}
[part~='card'] > button[part~='menu-button'] { align-self: flex-start; }
[part~='menu-layer'] { display: contents; }
[part~='menu-backdrop'] { position: fixed; inset: 0; z-index: 29; background: transparent; }
[part~='menu'] {
	position: absolute;
	right: 0.4rem;
	top: 0.4rem;
	z-index: 30;
	display: flex;
	flex-direction: column;
	min-width: 11rem;
	padding: 0.3rem 0;
	border: 1px solid var(--_border);
	border-radius: calc(var(--_radius) * 0.75);
	background: Canvas;
	color: CanvasText;
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
	outline: none;
}
button[part~='menu-item'] {
	font: inherit;
	text-align: left;
	padding: 0.55rem 0.95rem;
	border: none;
	background: none;
	color: inherit;
	cursor: pointer;
	white-space: nowrap;
}
button[part~='menu-item']:hover,
button[part~='menu-item']:focus-visible {
	background: color-mix(in srgb, var(--_accent) 10%, transparent);
}
button[part~='menu-item-danger'] { color: var(--_danger); }
@media (pointer: coarse) {
	button[part~='menu-item'] { padding: 0.8rem 1rem; }
}
@media (max-width: 500px) {
	[part~='menu-backdrop'] { background: rgba(0, 0, 0, 0.35); }
	[part~='menu'] {
		position: fixed;
		inset: auto 0 0 0;
		border-radius: var(--_radius) var(--_radius) 0 0;
		border-bottom: none;
		min-width: 0;
		padding: 0.4rem 0 max(0.5rem, env(safe-area-inset-bottom));
		box-shadow: 0 -12px 34px rgba(0, 0, 0, 0.28);
	}
	button[part~='menu-item'] { padding: 0.95rem 1.2rem; }
}
/* Responsive by default. The stack div above is the query container, so a
   widget reacts to ITS OWN width (a narrow column on a wide screen counts),
   and the host element's own sizing stays untouched. When the widget is
   narrow, a list card's row (QR + url + copy + revoke) would squeeze the
   text into a sliver: stack the card and centre the QR instead. */
@container (max-width: 480px) {
	li[part~='card'] {
		flex-direction: column;
		align-items: stretch;
	}
	li[part~='card'] img[part~='qr'] { align-self: center; }
	/* Stacked cards must not push the overflow trigger below the body: it
	   stays a top-right kebab (the card is position:relative already). */
	li[part~='card']:has(> button[part~='menu-button']) { padding-right: 2.4rem; }
	li[part~='card'] > button[part~='menu-button'] {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
	}
}
`;

type Child = Node | string | null | undefined;

/** Append children to an element, skipping null/undefined (conditional bits). */
export function put(el: HTMLElement, ...children: Child[]): void {
	for (const c of children) {
		if (c == null) continue;
		el.append(typeof c === 'string' ? document.createTextNode(c) : c);
	}
}

/** Tiny DOM builder: h('button', { part: 'button', onclick }, label). */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, unknown> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k.startsWith('on') && typeof v === 'function') {
			el.addEventListener(k.slice(2), v as EventListener);
		} else if (v === true) {
			el.setAttribute(k, '');
		} else {
			el.setAttribute(k, String(v));
		}
	}
	for (const c of children) {
		if (c == null) continue;
		el.append(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return el;
}

/** The common shell: shadow root + styles, label merging, focus-preserving
 *  re-render, event emission, subscription cleanup. */
export abstract class FlowWidget extends HTMLElement {
	protected root: ShadowRoot;
	private styleEl: HTMLStyleElement;
	private body: HTMLDivElement;
	private overrides: WidgetLabels = {};
	protected unsub: (() => void) | null = null;

	/** The widget's EN default strings; subclasses provide theirs. */
	protected abstract defaults(): WidgetLabels;
	/** Build the current view into the given container. */
	protected abstract view(into: HTMLElement): void;

	constructor() {
		super();
		this.root = this.attachShadow({ mode: 'open' });
		this.styleEl = document.createElement('style');
		this.styleEl.textContent = baseStyles;
		this.body = document.createElement('div');
		this.body.setAttribute('part', 'stack');
		this.root.append(this.styleEl, this.body);
	}

	/** Partial override map, merged over the EN defaults (also the i18n hook). */
	get labels(): WidgetLabels {
		return this.overrides;
	}
	set labels(map: WidgetLabels) {
		this.overrides = map ?? {};
		this.rerender();
	}

	protected t(key: string): string {
		return this.overrides[key] ?? this.defaults()[key] ?? key;
	}

	/** A heading an empty-string label removes: labels = { 'share.title': '' }
	 *  hides that heading (the host page already says it) without a fork.
	 *  Append through put(), which skips the null. */
	protected heading(part: string, key: string): HTMLElement | null {
		const text = this.t(key);
		return text ? h('div', { part }, text) : null;
	}

	/** Map a flow error to copy: labels can override per labelKey
	 *  ('error.targetUnavailable', ...), with a generic fallback. */
	protected errorText(labelKey: string | undefined): string {
		if (labelKey) {
			const specific = this.overrides[labelKey] ?? this.defaults()[labelKey];
			if (specific) return specific;
		}
		return this.t('error.generic');
	}

	protected emit(name: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
	}

	/** Rebuild the body, keeping the focused input's value and focus across the
	 *  rebuild (inputs carry data-keep so typing survives a snapshot change). */
	protected rerender(): void {
		// happy-dom's ShadowRoot.activeElement throws once the focused node was
		// replaced by an earlier rebuild; browsers just report null/body.
		let active: HTMLInputElement | null = null;
		try {
			active = this.root.activeElement as HTMLInputElement | null;
		} catch {
			active = null;
		}
		const keep = active?.getAttribute?.('data-keep') ?? null;
		const value = active?.value;
		this.body.replaceChildren();
		this.view(this.body);
		if (keep != null) {
			const again = this.body.querySelector<HTMLInputElement>(`[data-keep="${keep}"]`);
			if (again) {
				if (value != null) again.value = value;
				again.focus();
			}
		}
	}

	disconnectedCallback(): void {
		this.unsub?.();
		this.unsub = null;
	}
}
