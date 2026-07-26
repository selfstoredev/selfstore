/**
 * The file picker, and what "supported" is allowed to mean. Every rule here
 * comes from a browser that lies: the method is on `window`, so every presence
 * check says yes, and the call then throws. A host that believes the check
 * shows a destination that can never work.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { KV } from '../cache';

function memKv(): KV {
	const m = new Map<string, unknown>();
	return {
		async get<T>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k, v) {
			m.set(k, v);
		},
		async del(k) {
			m.delete(k);
		}
	};
}

/** A fresh copy of the module: the refusal it learns is remembered for the
 *  whole session, so tests must not inherit each other's browser. */
async function freshModule(win: Record<string, unknown>) {
	vi.resetModules();
	vi.stubGlobal('window', win);
	return import('./file');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('file target: presence is not capability', () => {
	it('stops claiming support once a picker that exists has refused', async () => {
		const showSaveFilePicker = vi.fn().mockRejectedValue(
			// Brave, picker flag off: the method is there and throws on call.
			new DOMException('User denied', 'NotAllowedError')
		);
		const file = await freshModule({ showSaveFilePicker });

		expect(file.isSupported()).toBe(true); // all we know before asking
		const target = await file.connect({ kv: memKv(), fileName: 'backup.zip' });

		expect(target).toBeNull(); // no file, and no exception thrown at the host
		expect(file.isSupported()).toBe(false); // asking is what taught us
	});

	it('keeps claiming support when the user simply cancelled', async () => {
		// The whole fix hangs on this line: a cancel is a person changing their
		// mind, not a browser limitation. Confusing the two would strip the file
		// mode off Chrome the first time someone presses Escape.
		const showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('', 'AbortError'));
		const file = await freshModule({ showSaveFilePicker });

		expect(await file.connect({ kv: memKv(), fileName: 'backup.zip' })).toBeNull();
		expect(file.isSupported()).toBe(true);
	});

	it('does not condemn the browser when one file denies permission', async () => {
		// Refusing to grant readwrite on THIS file says nothing about the picker,
		// which has just proved it opens.
		const handle = {
			name: 'backup.zip',
			requestPermission: vi.fn().mockResolvedValue('denied')
		};
		const file = await freshModule({
			showSaveFilePicker: vi.fn(),
			showOpenFilePicker: vi.fn().mockResolvedValue([handle])
		});

		expect(await file.openExisting({ kv: memKv() })).toBeNull();
		expect(file.isSupported()).toBe(true);
	});

	it('reports no support when opening an existing file is refused', async () => {
		const file = await freshModule({
			showSaveFilePicker: vi.fn(),
			showOpenFilePicker: vi.fn().mockRejectedValue(new DOMException('', 'SecurityError'))
		});

		expect(await file.openExisting({ kv: memKv() })).toBeNull();
		expect(file.isSupported()).toBe(false);
	});

	it('remembers the picked file for the next session', async () => {
		const kv = memKv();
		const handle = { name: 'cabinet.zip', requestPermission: vi.fn() };
		const file = await freshModule({ showSaveFilePicker: vi.fn().mockResolvedValue(handle) });

		const target = await file.connect({ kv, fileName: 'backup.zip' });

		expect(target?.label).toBe('cabinet.zip');
		expect(file.isSupported()).toBe(true);
		expect(await file.fromSession({ kv })).not.toBeNull();
	});
});
