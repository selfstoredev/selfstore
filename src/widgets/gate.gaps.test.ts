// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import type { ConnectFlowOptions } from '../flows/connect';
import type { SelfstoreGateElement } from './gate';
import { defineSelfstoreWidgets } from '../entries/widgets';

defineSelfstoreWidgets();

describe('SelfstoreGateElement options', () => {
	it('returns the default empty object', () => {
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		expect(el.options).toEqual({});
	});

	it('stores and retrieves a custom ConnectFlowOptions object', () => {
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		const custom: ConnectFlowOptions = { password: 'secret' };
		el.options = custom;
		expect(el.options).toEqual(custom);
	});

	it('coalesces null to an empty object', () => {
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		el.options = null as unknown as ConnectFlowOptions;
		expect(el.options).toEqual({});
	});

	it('coalesces undefined to an empty object', () => {
		const el = document.createElement('selfstore-gate') as SelfstoreGateElement;
		el.options = undefined as unknown as ConnectFlowOptions;
		expect(el.options).toEqual({});
	});
});
