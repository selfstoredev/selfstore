// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets } from '../entries/widgets';
import { SelfstoreJoinElement } from './join';

defineSelfstoreWidgets();

describe('SelfstoreJoinElement variant handling', () => {
	it.each([
		['banner', 'banner'],
		['card', 'card'],
		['unknown', 'card']
	])('sets variant correctly when variant="%s" attribute is present', (attr, expected) => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		el.setAttribute('variant', attr);
		el.connectedCallback();
		expect(el.variant).toBe(expected);
	});

	it('updates variant via attribute change after connection', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		el.connectedCallback();
		el.setAttribute('variant', 'banner');
		expect(el.variant).toBe('banner');
		el.setAttribute('variant', 'card');
		expect(el.variant).toBe('card');
		el.setAttribute('variant', 'unknown');
		expect(el.variant).toBe('card');
	});
});
