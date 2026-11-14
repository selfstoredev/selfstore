// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import type { ConnectKind } from '../flows/connect';
import { SelfstoreGateElement } from './gate';

describe('SelfstoreGateElement', () => {
	beforeAll(() => {
		if (!customElements.get('selfstore-gate')) {
			customElements.define('selfstore-gate', SelfstoreGateElement);
		}
	});

	it('icons getter returns default empty object', () => {
		const el = new SelfstoreGateElement();
		expect(el.icons).toEqual({});
	});

	it('icons setter updates getter', () => {
		const el = new SelfstoreGateElement();
		el.icons = { device: 'data:image/png,abc' } as Partial<Record<ConnectKind, string>>;
		expect(el.icons).toEqual({ device: 'data:image/png,abc' });
	});

	it('icons setter with null yields empty object', () => {
		const el = new SelfstoreGateElement();
		el.icons = null;
		expect(el.icons).toEqual({});
	});
});
