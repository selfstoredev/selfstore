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
 *  whole session, so tests must not inherit each other's browser. `gesture`
 *  says whether the call happens inside a live user activation - the default,
 *  since every picker a host opens properly does. */
async function freshModule(win: Record<string, unknown>, gesture = true) {
	vi.resetModules();
	vi.stubGlobal('window', win);
	vi.stubGlobal('navigator', { userActivation: { isActive: gesture } });
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

	it('keeps the file the user pointed at even when readwrite is refused', async () => {
		// The open picker consumes the activation a permission prompt needs, so
		// this answer can be 'prompt' without anyone having been asked. Dropping
		// the file here was the whole "I pick my file and nothing happens" bug:
		// the host went back to its own screen, silently, unchanged. The file is
		// adopted; a write that cannot happen raises the store's reconnect gate.
		const handle = {
			name: 'backup.zip',
			requestPermission: vi.fn().mockResolvedValue('denied')
		};
		const file = await freshModule({
			showSaveFilePicker: vi.fn(),
			showOpenFilePicker: vi.fn().mockResolvedValue([handle])
		});

		const target = await file.openExisting({ kv: memKv() });

		expect(target?.label).toBe('backup.zip');
		// Refusing to grant readwrite on THIS file says nothing about the picker,
		// which has just proved it opens.
		expect(file.isSupported()).toBe(true);
	});

	it('adopts the file even when no permission prompt was possible at all', async () => {
		const handle = {
			name: 'backup.zip',
			requestPermission: vi
				.fn()
				.mockRejectedValue(new DOMException('Must be handling a user gesture', 'NotAllowedError'))
		};
		const file = await freshModule({
			showSaveFilePicker: vi.fn(),
			showOpenFilePicker: vi.fn().mockResolvedValue([handle])
		});

		expect((await file.openExisting({ kv: memKv() }))?.label).toBe('backup.zip');
	});

	it('reports no support when opening an existing file is refused', async () => {
		const file = await freshModule({
			showSaveFilePicker: vi.fn(),
			showOpenFilePicker: vi.fn().mockRejectedValue(new DOMException('', 'SecurityError'))
		});

		expect(await file.openExisting({ kv: memKv() })).toBeNull();
		expect(file.isSupported()).toBe(false);
	});

	it('does not condemn the browser for a picker called outside a gesture', async () => {
		// The exception is indistinguishable from a browser that ships the picker
		// and refuses it - so the only honest reading is the one that also asks
		// whether the browser was allowed to answer. Read as a refusal, a single
		// mistimed call sent every later save down the manual download path on a
		// Chrome that can hold a file perfectly well.
		const file = await freshModule(
			{
				showSaveFilePicker: vi
					.fn()
					.mockRejectedValue(
						new DOMException(
							'Must be handling a user gesture to show a file picker.',
							'SecurityError'
						)
					)
			},
			false
		);

		expect(await file.connect({ kv: memKv(), fileName: 'backup.zip' })).toBeNull();
		expect(file.isSupported()).toBe(true); // ask again, from a real click
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

/**
 * What the store is allowed to conclude from a failed read or write. The target
 * contract (see target.ts) says a throw without a code reads as transient, so an
 * untyped DOMException means "momentarily unreachable, the next save retries" -
 * for a permission no retry can re-grant, and for a file no retry brings back.
 */
describe('file target: a failure carries the code that says what to do', () => {
	/** The target a past session left behind, built on a handle we control. */
	async function targetOn(handle: Record<string, unknown>) {
		const file = await freshModule({ showSaveFilePicker: vi.fn() });
		const kv = memKv();
		await kv.set('fileHandle', handle);
		const target = await file.fromSession({ kv });
		if (!target) throw new Error('no target');
		return target;
	}

	const dom = (name: string) => new DOMException('', name);

	it('reports a revoked write permission as a genuine loss of access', async () => {
		const target = await targetOn({
			name: 'backup.zip',
			createWritable: vi.fn().mockRejectedValue(dom('NotAllowedError'))
		});

		await expect(target.save(new Blob(['x']))).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
	});

	it('reports a deleted file as permanently gone, not as a write to retry', async () => {
		// The trap this closes: TARGET_WRITE_FAILED is retried silently forever,
		// and the store has already bumped lastSavedAt - so the app goes on saying
		// "saved" about a file that no longer exists.
		const target = await targetOn({
			name: 'backup.zip',
			createWritable: vi.fn().mockRejectedValue(dom('NotFoundError'))
		});

		await expect(target.save(new Blob(['x']))).rejects.toMatchObject({ code: 'TARGET_GONE' });
	});

	it('keeps an ordinary write failure retryable', async () => {
		const target = await targetOn({
			name: 'backup.zip',
			createWritable: vi.fn().mockRejectedValue(dom('QuotaExceededError'))
		});

		await expect(target.save(new Blob(['x']))).rejects.toMatchObject({
			code: 'TARGET_WRITE_FAILED'
		});
	});

	it('reports a revoked read permission as a loss of access, not a network blip', async () => {
		// Only a user gesture re-grants it: read as transient, the store waits for
		// a retry that can never succeed instead of raising the one-click gate.
		const target = await targetOn({
			name: 'backup.zip',
			getFile: vi.fn().mockRejectedValue(dom('NotAllowedError'))
		});

		await expect(target.load()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
	});

	it('reports a file that is no longer there as gone when reading it', async () => {
		const target = await targetOn({
			name: 'backup.zip',
			getFile: vi.fn().mockRejectedValue(dom('NotFoundError'))
		});

		await expect(target.load()).rejects.toMatchObject({ code: 'TARGET_GONE' });
	});

	it('never lets a bare browser exception reach the host from a read', async () => {
		const target = await targetOn({
			name: 'backup.zip',
			getFile: vi.fn().mockRejectedValue(dom('InvalidStateError'))
		});

		await expect(target.load()).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
	});

	it('still reads the file back as the version marker after a good write', async () => {
		const writable = { write: vi.fn(), close: vi.fn() };
		const target = await targetOn({
			name: 'backup.zip',
			createWritable: vi.fn().mockResolvedValue(writable),
			getFile: vi.fn().mockResolvedValue({ lastModified: 1234 })
		});

		expect(await target.save(new Blob(['x']))).toBe('1234');
		expect(writable.close).toHaveBeenCalled();
	});

	it('still answers "cannot tell" from stat rather than throwing', async () => {
		// stat() is deliberately the exception: a marker nobody could read is not
		// a failure to report, it is a fall-through to a full load.
		const target = await targetOn({
			name: 'backup.zip',
			getFile: vi.fn().mockRejectedValue(dom('NotAllowedError'))
		});

		expect(await target.stat?.()).toBeNull();
	});
});
