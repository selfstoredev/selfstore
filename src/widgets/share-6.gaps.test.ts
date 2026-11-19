// @vitest-environment happy-dom
import { defineSelfstoreWidgets } from '../entries/widgets';
import { SelfstoreShareElement } from './share';
import { describe, it, expect } from 'vitest';

defineSelfstoreWidgets();

describe('SelfstoreShareElement withMembers getter', () => {
	it('returns true by default', () => {
		const el = new SelfstoreShareElement();
		expect(el.withMembers).toBe(true);
	});

	it('reflects with-members="off" attribute', () => {
		const el = new SelfstoreShareElement();
		el.setAttribute('with-members', 'off');
		expect(el.withMembers).toBe(false);
	});

	it('sets withMembers property directly', () => {
		const el = new SelfstoreShareElement();
		el.withMembers = false;
		expect(el.withMembers).toBe(false);
	});

	it('returns true after removing attribute', () => {
		const el = new SelfstoreShareElement();
		el.setAttribute('with-members', 'off');
		el.removeAttribute('with-members');
		expect(el.withMembers).toBe(true);
	});
});
