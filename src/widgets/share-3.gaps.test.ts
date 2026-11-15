// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets } from '../entries/widgets';
import { SelfstoreShareElement } from './share';
import type { ShareLevel } from '../flows/share';

defineSelfstoreWidgets();

describe('SelfstoreShareElement.levels getter', () => {
	it('returns a shallow copy of internal #levels array', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		const first = el.levels;
		expect(first).toEqual(['read', 'write'] as ShareLevel[]);
		expect(first).not.toBe(el.levels);
		first.push('read');
		expect(el.levels).toEqual(['read', 'write'] as ShareLevel[]);
	});

	it('updates after setter', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		el.levels = ['read'];
		expect(el.levels).toEqual(['read'] as ShareLevel[]);
		const copy = el.levels;
		copy.push('write');
		expect(el.levels).toEqual(['read'] as ShareLevel[]);
	});

	it('parses attribute "levels"', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		el.setAttribute('levels', 'write, read');
		expect(el.levels).toEqual(['write', 'read'] as ShareLevel[]);
	});

	it('defaults to empty attribute returns default levels', () => {
		const el = document.createElement('selfstore-share') as SelfstoreShareElement;
		el.setAttribute('levels', '');
		expect(el.levels).toEqual(['read', 'write'] as ShareLevel[]);
	});
});
