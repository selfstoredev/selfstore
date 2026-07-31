// selfstore/widgets - the connect / share / join / backups journeys as
// drop-in custom elements, skins over the headless flows. Framework-free:
// plain HTML, Svelte, Vue and React all take them as-is.
//
//   import { defineSelfstoreWidgets } from 'selfstore/widgets';
//   defineSelfstoreWidgets();
//
// Customization is layered, never a fork: --selfstore-* CSS custom
// properties, ::part() on every node, a `labels` map merged over the EN
// defaults (also the localization story), per-widget attributes with the
// full journey as the default, and bubbling composed `selfstore-*` events.
// The full knob and event list lives in the README.

export { SelfstoreConnectElement, type WebdavPreset } from '../widgets/connect';
export { SelfstoreShareElement, type ShareAction } from '../widgets/share';
export { SelfstoreJoinElement } from '../widgets/join';
export { SelfstoreStatusElement } from '../widgets/status';
export { SelfstoreBackupsElement, type BackupsAction } from '../widgets/backups';
export { SelfstoreGateElement } from '../widgets/gate';
export { SelfstoreDestinationElement, type DestinationAction } from '../widgets/destination';
export { SelfstoreStorageElement } from '../widgets/storage';
export { SelfstoreAccountElement } from '../widgets/account';
export { FlowWidget, type WidgetLabels } from '../widgets/base';
/** The neutral destination glyphs the widgets fall back to. Public because an
 *  app that draws a destination card of its own - a chooser, a list of files -
 *  otherwise redraws them, and two drawings of one thing drift. They are
 *  deliberately not brand marks: see widgets/icons.ts. */
export { defaultIcons } from '../widgets/icons';

import { SelfstoreConnectElement } from '../widgets/connect';
import { SelfstoreShareElement } from '../widgets/share';
import { SelfstoreJoinElement } from '../widgets/join';
import { SelfstoreStatusElement } from '../widgets/status';
import { SelfstoreBackupsElement } from '../widgets/backups';
import { SelfstoreGateElement } from '../widgets/gate';
import { SelfstoreDestinationElement } from '../widgets/destination';
import { SelfstoreStorageElement } from '../widgets/storage';
import { SelfstoreAccountElement } from '../widgets/account';

function register(prefix: string, tags: Record<string, CustomElementConstructor>): void {
	for (const [name, ctor] of Object.entries(tags)) {
		const tag = `${prefix}-${name}`;
		if (!customElements.get(tag)) customElements.define(tag, ctor);
	}
}

// Each widget gets its own register function, and none of them mentions a
// widget it does not need. That is the whole point: `defineSelfstoreWidgets`
// names all nine elements, so no bundler can drop any of them, and an app that
// shows a first-run screen still ships the backups manager it never renders.
// Import one of these instead and the rest tree-shakes away.
//
// A widget that COMPOSES another registers it too - the composition happens by
// tag name, so a missing child would render as an empty element rather than
// fail loudly.

/** Register <PREFIX-connect>: the "where does my data live" journey. */
export function defineConnect(prefix = 'selfstore'): void {
	register(prefix, { connect: SelfstoreConnectElement });
}

/** Register <PREFIX-status>: the live storage status line. */
export function defineStatus(prefix = 'selfstore'): void {
	register(prefix, { status: SelfstoreStatusElement });
}

/** Register <PREFIX-share>: publishing an invitation. */
export function defineShare(prefix = 'selfstore'): void {
	register(prefix, { share: SelfstoreShareElement });
}

/** Register <PREFIX-join>: accepting an invitation. */
export function defineJoin(prefix = 'selfstore'): void {
	register(prefix, { join: SelfstoreJoinElement });
}

/** Register <PREFIX-backups>: the named-backup manager. */
export function defineBackups(prefix = 'selfstore'): void {
	register(prefix, { backups: SelfstoreBackupsElement });
}

/** Register <PREFIX-gate>, the blocking first-run screen, with the
 *  <PREFIX-connect> child it builds for itself. */
export function defineGate(prefix = 'selfstore'): void {
	register(prefix, { connect: SelfstoreConnectElement, gate: SelfstoreGateElement });
}

/** Register <PREFIX-destination>, the storage panel, with the connect and
 *  status elements it composes. */
export function defineDestination(prefix = 'selfstore'): void {
	register(prefix, {
		connect: SelfstoreConnectElement,
		status: SelfstoreStatusElement,
		destination: SelfstoreDestinationElement
	});
}

/** Register <PREFIX-storage>: the whole journey in one tag. It chooses between
 *  the gate and the destination panel from the engine's own status, so both
 *  come with it. */
export function defineStorage(prefix = 'selfstore'): void {
	defineGate(prefix);
	defineDestination(prefix);
	register(prefix, { storage: SelfstoreStorageElement });
}

/** Register <PREFIX-account>, the header control, with the status row it
 *  composes for anything needing attention. */
export function defineAccount(prefix = 'selfstore'): void {
	register(prefix, {
		status: SelfstoreStatusElement,
		account: SelfstoreAccountElement
	});
}

/** Register all nine elements at once (default prefix 'selfstore'). Safe to
 *  call twice; throws in environments without custom elements (browser code
 *  only).
 *
 *  Convenient, and the reason a small app ships every widget: naming all nine
 *  here is what pins them in the bundle. Reach for the single-widget functions
 *  above when size matters. */
export function defineSelfstoreWidgets(prefix = 'selfstore'): void {
	register(prefix, {
		connect: SelfstoreConnectElement,
		share: SelfstoreShareElement,
		join: SelfstoreJoinElement,
		status: SelfstoreStatusElement,
		backups: SelfstoreBackupsElement,
		gate: SelfstoreGateElement,
		destination: SelfstoreDestinationElement,
		storage: SelfstoreStorageElement,
		account: SelfstoreAccountElement
	});
}
