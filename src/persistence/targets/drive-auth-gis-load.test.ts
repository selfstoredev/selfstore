// @vitest-environment happy-dom
/**
 * Loading Google Identity Services. The consent popup only opens inside the
 * user activation of a click, so the script has to be there BEFORE the click,
 * and a load that failed once must not fail every later click.
 *
 * The module holds the load in flight, so each test imports a fresh copy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

type Gis = typeof import('./drive-auth-gis');

/** Script tags the module asked the page to load, kept off the network. */
function captureScripts(): HTMLScriptElement[] {
	const added: HTMLScriptElement[] = [];
	vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
		added.push(node as unknown as HTMLScriptElement);
		return node;
	});
	return added;
}

/** What the script defines once it has run: just enough for one token. */
function gisArrives(): void {
	(globalThis.window as unknown as { google: unknown }).google = {
		accounts: {
			oauth2: {
				initTokenClient(cfg: { callback: (r: { access_token: string }) => void }) {
					return { requestAccessToken: () => cfg.callback({ access_token: 'tok' }) };
				}
			}
		}
	};
}

async function fresh(): Promise<Gis> {
	vi.resetModules();
	return import('./drive-auth-gis');
}

beforeEach(() => {
	vi.restoreAllMocks();
	delete (globalThis.window as unknown as { google?: unknown }).google;
});

describe('preloadGoogleIdentity', () => {
	it('starts the load before any click, and the click reuses it', async () => {
		const added = captureScripts();
		const { preloadGoogleIdentity, gisDriveAuth } = await fresh();

		preloadGoogleIdentity();
		preloadGoogleIdentity();
		expect(added).toHaveLength(1);
		expect(added[0]?.src).toBe(GIS_SRC);

		const token = gisDriveAuth({ clientId: 'cid' }).token();
		gisArrives();
		added[0]?.onload?.(new Event('load'));

		expect(await token).toBe('tok');
		expect(added).toHaveLength(1); // the click waited on the same tag
	});

	it('adds nothing once the script has run', async () => {
		const added = captureScripts();
		gisArrives();
		const { preloadGoogleIdentity } = await fresh();

		preloadGoogleIdentity();

		expect(added).toHaveLength(0);
	});

	it('a failed preload reports nothing and the click tries again', async () => {
		const added = captureScripts();
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		const { preloadGoogleIdentity, gisDriveAuth } = await fresh();

		preloadGoogleIdentity();
		added[0]?.onerror?.(new Event('error'));
		await new Promise((r) => setTimeout(r, 0));
		process.off('unhandledRejection', unhandled);
		expect(unhandled).not.toHaveBeenCalled();

		const token = gisDriveAuth({ clientId: 'cid' }).token();
		expect(added).toHaveLength(2);
		gisArrives();
		added[1]?.onload?.(new Event('load'));
		expect(await token).toBe('tok');
	});
});

describe('a load that failed', () => {
	it('is forgotten, so the next click does not fail on the same promise', async () => {
		const added = captureScripts();
		const { gisDriveAuth } = await fresh();
		const auth = gisDriveAuth({ clientId: 'cid' });

		const first = auth.token();
		const failed = added[0];
		const removed = vi.spyOn(failed as HTMLScriptElement, 'remove');
		failed?.onerror?.(new Event('error'));
		await expect(first).rejects.toThrow('GIS failed to load');
		expect(removed).toHaveBeenCalled(); // the dead tag leaves the page

		const second = auth.token();
		expect(added).toHaveLength(2);
		gisArrives();
		added[1]?.onload?.(new Event('load'));
		expect(await second).toBe('tok');
	});
});
