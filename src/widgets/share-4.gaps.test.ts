// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets, SelfstoreShareElement } from '../entries/widgets';

defineSelfstoreWidgets();

describe('SelfstoreShareElement.confirmAction', () => {
	it('returns null by default', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		expect(el.confirmAction).toBeNull();
	});

	it('returns the function set via setter', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		const fn = () => true;
		el.confirmAction = fn;
		expect(el.confirmAction).toBe(fn);
	});
});
