// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { defineSelfstoreWidgets, SelfstoreGateElement } from '../entries/widgets';
import type { WebdavPreset } from './connect';

defineSelfstoreWidgets();

describe('SelfstoreGateElement.webdavPresets', () => {
	it('returns empty array by default', () => {
		const el = new SelfstoreGateElement();
		expect(el.webdavPresets).toEqual([]);
	});

	it('returns the same array reference that was set', () => {
		const el = new SelfstoreGateElement();
		const presets: WebdavPreset[] = [
			{ id: '1', label: 'A', url: 'https://a.example' },
			{ id: '2', label: 'B', url: 'https://b.example' }
		];
		el.webdavPresets = presets;
		expect(el.webdavPresets).toBe(presets);
	});

	it('coerces null to empty array', () => {
		const el = new SelfstoreGateElement();
		el.webdavPresets = null as unknown as WebdavPreset[] | null;
		expect(el.webdavPresets).toEqual([]);
	});

	it('coerces undefined to empty array', () => {
		const el = new SelfstoreGateElement();
		el.webdavPresets = undefined as unknown as WebdavPreset[] | null;
		expect(el.webdavPresets).toEqual([]);
	});

	it('coerces non-array to empty array', () => {
		const el = new SelfstoreGateElement();
		el.webdavPresets = 'not an array' as unknown as WebdavPreset[] | null;
		expect(el.webdavPresets).toEqual([]);
	});

	it('calls rerender when setter is invoked', () => {
		const el = new SelfstoreGateElement();
		const rerenderSpy = vi.spyOn(el as unknown as { rerender: () => void }, 'rerender');
		el.webdavPresets = [{ id: 'x', label: 'X', url: 'https://x.example' }];
		expect(rerenderSpy).toHaveBeenCalledOnce();
	});
});
