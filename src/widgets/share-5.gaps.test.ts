// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets, SelfstoreShareElement } from '../entries/widgets';

defineSelfstoreWidgets();

describe('SelfstoreShareElement withCreate', () => {
	it('defaults to true', () => {
		const el = new SelfstoreShareElement();
		expect(el.withCreate).toBe(true);
	});

	it('reflects false after property set', () => {
		const el = new SelfstoreShareElement();
		el.withCreate = false;
		expect(el.withCreate).toBe(false);
	});
});
