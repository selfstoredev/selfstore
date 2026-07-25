// @vitest-environment happy-dom
/**
 * downloadBackup() and the save dialog. Separate from simple.test.ts because
 * this one needs a DOM: the save path is the only part of the simple store that
 * touches the page.
 *
 * What it guards: telling an app a backup happened when the user closed the
 * dialog is the one lie that surfaces on the worst possible day. The pending
 * download flag must survive too - it is what keeps asking for the file the
 * user still does not have.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { selfstore, type SimpleStore } from './simple';
import { memoryCache } from '../persistence/cache';

const open: SimpleStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
	delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

async function makeStore() {
	const store = await selfstore('download-test', { cache: memoryCache() });
	open.push(store);
	return store;
}

/** Count the calls without replacing the engine: the flag lives behind it. */
function watchMarkDownloaded(store: SimpleStore): () => number {
	let calls = 0;
	const engine = store.advanced;
	const original = engine.markDownloaded.bind(engine);
	engine.markDownloaded = () => {
		calls++;
		original();
	};
	return () => calls;
}

describe('downloadBackup', () => {
	it('reports no download and leaves the flag alone when the dialog is closed', async () => {
		const store = await makeStore();
		const calls = watchMarkDownloaded(store);
		(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {
			throw new DOMException('cancelled', 'AbortError');
		};

		await expect(store.downloadBackup()).resolves.toBe(false);
		expect(calls()).toBe(0);
	});

	it('reports the download and clears the flag once bytes are written', async () => {
		const store = await makeStore();
		const calls = watchMarkDownloaded(store);
		(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => ({
			createWritable: async () => ({
				write: async () => undefined,
				close: async () => undefined
			})
		});

		await expect(store.downloadBackup()).resolves.toBe(true);
		expect(calls()).toBe(1);
	});
});
