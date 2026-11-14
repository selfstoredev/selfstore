// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { defineSelfstoreWidgets, SelfstoreBackupsElement } from '../entries/widgets';
import './backups';

defineSelfstoreWidgets();

describe('BackupsWidget with-* property flags', () => {
	it('withDelete getter returns default and setter coerces truthy to true, false to false', () => {
		const el = document.createElement('selfstore-backups') as SelfstoreBackupsElement;
		expect(el.withDelete).toBe(true);
		el.withDelete = true;
		expect(el.withDelete).toBe(true);
		el.withDelete = false;
		expect(el.withDelete).toBe(false);
		el.withDelete = 'anything' as unknown as boolean;
		expect(el.withDelete).toBe(true);
	});

	it('withOpen getter returns default and setter coerces truthy to true, false to false', () => {
		const el = document.createElement('selfstore-backups') as SelfstoreBackupsElement;
		expect(el.withOpen).toBe(true);
		el.withOpen = true;
		expect(el.withOpen).toBe(true);
		el.withOpen = false;
		expect(el.withOpen).toBe(false);
	});

	it('withEncrypt getter returns default and setter coerces truthy to true, false to false', () => {
		const el = document.createElement('selfstore-backups') as SelfstoreBackupsElement;
		expect(el.withEncrypt).toBe(true);
		el.withEncrypt = true;
		expect(el.withEncrypt).toBe(true);
		el.withEncrypt = false;
		expect(el.withEncrypt).toBe(false);
	});
});
