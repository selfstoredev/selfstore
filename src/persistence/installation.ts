/**
 * Whether this browser will keep the local store, and what the user can do
 * about it.
 *
 * One browser does not merely inconvenience a local-first app, it DELETES its
 * data: Safari erases script-writable storage after seven days of browser use
 * without interaction with the site. Someone who closes for three weeks comes
 * back to an empty app, and nothing warned them - which is also the moment they
 * notice it last.
 *
 * Adding the app to the Dock or the Home Screen switches its storage to
 * persistent mode, which WebKit exempts from its eviction triggers. WebKit does
 * not write anywhere that this neutralises the inactivity rule by name, so this
 * module reports an advisory, never a guarantee.
 *
 * The library ships no user-facing copy: it names the situation, the host writes
 * the sentence.
 */

/** What stands between this browser and keeping the data. */
export type StorageRisk =
	/** Nothing known against it: the store survives until the user clears it. */
	| 'none'
	/** Data is erased when the tab closes (private browsing). Refuse to set up here. */
	| 'ephemeral'
	/** Erased after a stretch of not opening the app, unless it is installed. */
	| 'evicted-when-idle';

export interface StorageAdvice {
	risk: StorageRisk;
	/** The gesture that removes the risk, when there is one. Stable key; the
	 *  host owns the wording and the platform-specific instructions. */
	remedy?: 'install-to-dock' | 'install-to-home-screen';
	/** Already running as an installed app, so the remedy is done. */
	installed: boolean;
}

/** Real Safari, not Chrome or Edge on macOS - all three carry "Safari" in the
 *  user agent, and only Safari carries none of the others' tokens. */
function isSafari(ua: string): boolean {
	return /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua) && !/OPR\/|Android/.test(ua);
}

function isStandalone(): boolean {
	if (typeof window === 'undefined') return false;
	const displayMode = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
	// iOS and iPadOS kept their own flag, older than display-mode.
	const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return displayMode || ios;
}

/**
 * What this browser will do with the local store, and the one gesture that
 * changes it. Call it before setting up, and again in whatever screen owns the
 * data: the advice disappears on its own once the remedy is applied.
 */
export function storageAdvice(): StorageAdvice {
	if (typeof navigator === 'undefined' || typeof window === 'undefined') {
		return { risk: 'none', installed: false };
	}
	const installed = isStandalone();
	if (!isSafari(navigator.userAgent) || installed) {
		return { risk: 'none', installed };
	}
	const touch = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
	return {
		risk: 'evicted-when-idle',
		remedy: touch ? 'install-to-home-screen' : 'install-to-dock',
		installed: false
	};
}
