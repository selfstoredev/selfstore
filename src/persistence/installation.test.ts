import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageAdvice } from './installation';

/**
 * The advisory must fire on Safari and nowhere else. The trap is known: on
 * macOS, Chrome, Edge and Opera all carry "Safari" in their user agent. A naive
 * test warns all four about a risk three of them do not have, and a warning
 * handed out wrongly stops being read.
 */

const SAFARI_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SAFARI_IPAD =
	'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_MAC = CHROME_MAC + ' Edg/126.0.0.0';
const OPERA_MAC = CHROME_MAC + ' OPR/112.0.0.0';
const FIREFOX =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';

function browser(ua: string, opts: { standalone?: boolean; touch?: number } = {}) {
	vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: opts.touch ?? 0 });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: opts.standalone === true }) });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('storageAdvice', () => {
	it('flags the browser that erases idle sites, and names the gesture', () => {
		browser(SAFARI_MAC);
		expect(storageAdvice()).toEqual({
			risk: 'evicted-when-idle',
			remedy: 'install-to-dock',
			installed: false
		});
	});

	it('asks for the home screen on a touch device', () => {
		browser(SAFARI_IPAD, { touch: 5 });
		expect(storageAdvice().remedy).toBe('install-to-home-screen');
	});

	it('goes quiet once the app runs installed', () => {
		// The gesture is done; repeating the ask would be nagging.
		browser(SAFARI_MAC, { standalone: true });
		expect(storageAdvice()).toEqual({ risk: 'none', installed: true });
	});

	it('stays quiet on browsers that only claim to be Safari', () => {
		for (const ua of [CHROME_MAC, EDGE_MAC, OPERA_MAC]) {
			browser(ua);
			expect(storageAdvice().risk, ua).toBe('none');
		}
	});

	it('stays quiet on Firefox, which deletes nothing on its own', () => {
		browser(FIREFOX);
		expect(storageAdvice().risk).toBe('none');
	});

	it('answers something usable outside a browser', () => {
		// Server-side rendering must not throw on a missing navigator.
		vi.unstubAllGlobals();
		vi.stubGlobal('navigator', undefined);
		expect(storageAdvice().risk).toBe('none');
	});
});
