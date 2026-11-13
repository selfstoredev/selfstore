// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets, SelfstoreJoinElement } from '../entries/widgets';

defineSelfstoreWidgets();

describe('SelfstoreJoinElement options getter', () => {
	it('returns empty object by default', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		expect(el.options).toEqual({});
	});

	it('returns the exact object that was set', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		const opts = { deadlineMs: 12345 };
		el.options = opts;
		expect(el.options).toBe(opts);
		expect(el.options).toEqual({ deadlineMs: 12345 });
	});

	it('returns empty object when set to null', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		el.options = { deadlineMs: 1 };
		el.options = null;
		expect(el.options).toEqual({});
	});

	it('returns updated object after reassignment', () => {
		const el = document.createElement('selfstore-join') as SelfstoreJoinElement;
		el.options = { deadlineMs: 100 };
		const first = el.options;
		el.options = { deadlineMs: 200 };
		expect(el.options).not.toBe(first);
		expect(el.options).toEqual({ deadlineMs: 200 });
	});
});
