// @vitest-environment happy-dom
/**
 * Properties set BEFORE the widget's class is defined must still land.
 *
 * The failure this guards against is silent and points nowhere near its cause:
 * a host that loads the widgets lazily writes `el.store = handle` on an element
 * whose class does not exist yet. That assignment creates an own property on
 * the instance; once the class is defined, the own property shadows the
 * accessor for good. The setter never runs, the widget never learns it has a
 * store, and it renders nothing while the console stays empty.
 *
 * The end-to-end version of this cannot be reproduced here: happy-dom does not
 * upgrade elements created before `customElements.define`, it merely calls
 * their connectedCallback on a plain HTMLElement. So the test drives the
 * mechanism directly, on the state a real upgrade leaves behind: an own
 * property shadowing the accessor.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { defineSelfstoreWidgets } from '../entries/widgets';
import { upgradeOwnProperties } from './base';

beforeAll(() => defineSelfstoreWidgets());

/** Enough of a store to be accepted and remembered, not to be exercised. */
function stubStore() {
	return { flowHost: { state: null, subscribe: () => () => {} } };
}

/** Each widget with the property a host hands it first: the one whose loss
 *  leaves the widget silent. Not all of them take a store. */
const WIDGETS: [tag: string, main: string][] = [
	['selfstore-connect', 'store'],
	['selfstore-status', 'store'],
	['selfstore-gate', 'store'],
	['selfstore-backups', 'manager'],
	['selfstore-share', 'engine'],
	['selfstore-join', 'engine']
];
const TAGS = WIDGETS.map(([tag]) => tag);

/** Exactly what a host assignment on a not-yet-defined element leaves. */
function shadowAccessor(el: HTMLElement, name: string, value: unknown) {
	Object.defineProperty(el, name, { value, writable: true, configurable: true, enumerable: true });
}

describe('upgradeOwnProperties', () => {
	it.each(WIDGETS)('%s: the shadowed %s reaches the accessor', (tag, main) => {
		const el = document.createElement(tag);
		const given = stubStore();
		shadowAccessor(el, main, given);
		expect(Object.getOwnPropertyDescriptor(el, main)).toBeDefined();

		upgradeOwnProperties(el);

		// No own property left: the accessor is the one answering now.
		expect(Object.getOwnPropertyDescriptor(el, main)).toBeUndefined();
		expect((el as unknown as Record<string, unknown>)[main]).toBe(given);
	});

	it.each(TAGS)('%s: the shadowed labels reach the accessor', (tag) => {
		const el = document.createElement(tag) as HTMLElement & { labels?: unknown };
		shadowAccessor(el, 'labels', { 'connect.cancel': 'Annuler' });

		upgradeOwnProperties(el);

		expect(Object.getOwnPropertyDescriptor(el, 'labels')).toBeUndefined();
		expect(el.labels).toEqual({ 'connect.cancel': 'Annuler' });
	});

	it('leaves properties the widget does not expose alone', () => {
		// Only names a prototype accessor answers are touched. A field the host
		// happened to hang on the element is none of the widget's business.
		const el = document.createElement('selfstore-status') as HTMLElement & { hostNote?: string };
		el.hostNote = 'kept';

		upgradeOwnProperties(el);

		expect(el.hostNote).toBe('kept');
		expect(Object.getOwnPropertyDescriptor(el, 'hostNote')).toBeDefined();
	});

	it('does nothing to an element that was never upgraded', () => {
		// happy-dom's case, and the reason this is a function and not a method:
		// a plain element has no accessors to hand back, and must not throw.
		const plain = document.createElement('div') as HTMLElement & { store?: unknown };
		plain.store = stubStore();

		expect(() => upgradeOwnProperties(plain)).not.toThrow();
		expect(plain.store).toBeTruthy();
	});
});
