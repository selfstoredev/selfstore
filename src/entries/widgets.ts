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
export { FlowWidget, type WidgetLabels } from '../widgets/base';

import { SelfstoreConnectElement } from '../widgets/connect';
import { SelfstoreShareElement } from '../widgets/share';
import { SelfstoreJoinElement } from '../widgets/join';
import { SelfstoreStatusElement } from '../widgets/status';
import { SelfstoreBackupsElement } from '../widgets/backups';

/** Register the elements as <PREFIX-connect>, <PREFIX-share>, <PREFIX-join>,
 *  <PREFIX-status> and <PREFIX-backups> (default prefix 'selfstore'). Safe to
 *  call twice; throws in environments without custom elements (browser code
 *  only). */
export function defineSelfstoreWidgets(prefix = 'selfstore'): void {
	const define = (name: string, ctor: CustomElementConstructor): void => {
		if (!customElements.get(name)) customElements.define(name, ctor);
	};
	define(`${prefix}-connect`, SelfstoreConnectElement);
	define(`${prefix}-share`, SelfstoreShareElement);
	define(`${prefix}-join`, SelfstoreJoinElement);
	define(`${prefix}-status`, SelfstoreStatusElement);
	define(`${prefix}-backups`, SelfstoreBackupsElement);
}
