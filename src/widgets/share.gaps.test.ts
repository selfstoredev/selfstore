// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets } from '../entries/widgets';
import { SelfstoreShareElement } from './share';

defineSelfstoreWidgets();

describe('SelfstoreShareElement options', () => {
	it('returns empty object initially', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		expect(el.options).toEqual({});
	});

	it('reflects assigned options object', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		const opt = { deadlineMs: 123 };
		el.options = opt;
		expect(el.options).toBe(opt);
	});

	it('sets to null results in empty object', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		el.options = { deadlineMs: 999 };
		el.options = null;
		expect(el.options).toEqual({});
	});
});
