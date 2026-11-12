// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { SelfstoreShareElement } from '../entries/widgets';
import { defineSelfstoreWidgets } from '../entries/widgets';

defineSelfstoreWidgets();

describe('share.ts qrProvider getter', () => {
	let el: SelfstoreShareElement;

	beforeEach(() => {
		el = document.createElement('selfstore-share') as SelfstoreShareElement;
		// attach to DOM to trigger connectedCallback
		document.body.appendChild(el);
	});

	it('returns the injected qrProvider when set', () => {
		const fakeProvider = async (url: string) => `data:image/png;base64,${btoa(url)}`;
		el.qrProvider = fakeProvider;
		expect(el.qrProvider).toBe(fakeProvider);
	});

	it('returns null when qrProvider is unset', () => {
		const fakeProvider = async (url: string) => `data:image/png;base64,${btoa(url)}`;
		el.qrProvider = fakeProvider;
		expect(el.qrProvider).toBe(fakeProvider);
		el.qrProvider = null;
		expect(el.qrProvider).toBeNull();
	});

	it('getter returns the same reference after reassigning the same function', () => {
		const provider = async (_: string) => 'data';
		el.qrProvider = provider;
		expect(el.qrProvider).toBe(provider);
		el.qrProvider = provider; // same function
		expect(el.qrProvider).toBe(provider);
	});
});
