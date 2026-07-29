/**
 * The desktop file target. Two rules carry most of this file: a shell answers
 * before the browser probe, because inside a native webview that probe is
 * misleading rather than merely negative; and a write that fails on a desktop
 * is transient, never a lost grant, because there is no grant to lose.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { KV } from '../cache';
import type { DesktopFileBridge } from './desktop';

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

/** A shell that keeps its files in memory. `mtime` is what the store reads as
 *  the version marker; a shell that cannot report one passes null. */
function fakeShell(over: Partial<DesktopFileBridge> = {}) {
	const files = new Map<string, Uint8Array>();
	let clock = 1000;
	const shell: DesktopFileBridge = {
		async readFile(path) {
			const bytes = files.get(path);
			if (!bytes) throw new Error(`no such file: ${path}`);
			return bytes;
		},
		async writeFile(path, data) {
			files.set(path, data);
			clock += 1;
		},
		async stat(path) {
			return files.has(path) ? { mtime: new Date(clock) } : null;
		},
		async exists(path) {
			return files.has(path);
		},
		async save() {
			return 'C:/backups/app.zip';
		},
		async open() {
			return 'C:/backups/app.zip';
		},
		...over
	};
	return { shell, files };
}

/** Fresh module registry, so the registered shell never leaks between cases.
 *  file.ts and desktop.ts must come from the SAME registry or the delegation
 *  test would wire one module's state to another module's copy. */
async function freshModules() {
	vi.resetModules();
	const desktop = await import('./desktop');
	const file = await import('./file');
	return { desktop, file };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('registration', () => {
	it('reports no shell until one is registered, and lets it be withdrawn', async () => {
		const { desktop } = await freshModules();
		expect(desktop.hasDesktopFiles()).toBe(false);

		desktop.useDesktopFiles(fakeShell().shell);
		expect(desktop.hasDesktopFiles()).toBe(true);

		desktop.useDesktopFiles(null);
		expect(desktop.hasDesktopFiles()).toBe(false);
	});

	it('connects to nothing while no shell is registered', async () => {
		const { desktop } = await freshModules();
		expect(await desktop.connect({ kv: memKv(), fileName: 'app.zip' })).toBeNull();
		expect(await desktop.openExisting({ kv: memKv() })).toBeNull();
		expect(await desktop.fromSession({ kv: memKv() })).toBeNull();
	});
});

describe('connecting', () => {
	it('remembers the chosen path and names the target after the file', async () => {
		const { desktop } = await freshModules();
		const { shell } = fakeShell({ save: async () => 'C:/Users/x/Documents/cabinet.zip' });
		desktop.useDesktopFiles(shell);
		const kv = memKv();

		const target = await desktop.connect({ kv, fileName: 'app.zip' });

		expect(target?.kind).toBe('file');
		expect(target?.label).toBe('cabinet.zip');
		expect(await kv.get('desktopFilePath')).toBe('C:/Users/x/Documents/cabinet.zip');
	});

	it('reads the last segment of a POSIX path too', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell({ save: async () => '/home/x/backups/app.zip' }).shell);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(target?.label).toBe('app.zip');
	});

	it('returns null when the dialog is cancelled, and remembers nothing', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell({ save: async () => null }).shell);
		const kv = memKv();

		expect(await desktop.connect({ kv, fileName: 'app.zip' })).toBeNull();
		expect(await kv.get('desktopFilePath')).toBeUndefined();
	});

	it('takes the first path when the open dialog answers with an array', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(
			fakeShell({ open: async () => ['C:/a/one.zip', 'C:/a/two.zip'] }).shell
		);

		const target = await desktop.openExisting({ kv: memKv() });

		expect(target?.label).toBe('one.zip');
	});

	it('treats an empty array from the open dialog as a cancellation', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell({ open: async () => [] }).shell);

		expect(await desktop.openExisting({ kv: memKv() })).toBeNull();
	});
});

describe('reading and writing', () => {
	it('writes the blob and hands back the file time as the version marker', async () => {
		const { desktop } = await freshModules();
		const { shell, files } = fakeShell();
		desktop.useDesktopFiles(shell);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });
		const marker = await target?.save(new Blob([new Uint8Array([1, 2, 3])]));

		expect([...(files.get('C:/backups/app.zip') ?? [])]).toEqual([1, 2, 3]);
		expect(marker).toBe('1001');
	});

	it('round-trips the bytes back out', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell().shell);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });
		await target?.save(new Blob([new Uint8Array([7, 8])]));
		const loaded = await target?.load();

		expect([...new Uint8Array(await loaded!.arrayBuffer())]).toEqual([7, 8]);
	});

	it('answers "no backup" rather than failing on a path nothing was written to yet', async () => {
		// This is the normal state right after the save dialog: the user named a
		// file that does not exist until the first write.
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell().shell);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(await target?.load()).toBeNull();
	});

	it('reports a failed write as transient, never as a lost grant', async () => {
		// A desktop write fails because the disk is full or the volume is
		// unplugged. Raising the reconnect gate would ask the user to re-pick a
		// file that never moved.
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(
			fakeShell({
				async writeFile() {
					throw new Error('device not ready');
				}
			}).shell
		);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		await expect(target?.save(new Blob(['x']))).rejects.toMatchObject({
			code: 'TARGET_WRITE_FAILED'
		});
	});

	it('says "cannot tell" instead of throwing when the shell has no file time', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(
			fakeShell({
				async stat() {
					throw new Error('stat unavailable');
				}
			}).shell
		);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(await target!.stat!()).toBeNull();
	});

	it('accepts a file time given as epoch milliseconds', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(
			fakeShell({
				async stat() {
					return { mtime: 1700000000000 };
				}
			}).shell
		);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(await target!.stat!()).toBe('1700000000000');
	});

	it('reads an absent file time as no information', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(
			fakeShell({
				async stat() {
					return { mtime: null };
				}
			}).shell
		);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(await target!.stat!()).toBeNull();
	});
});

describe('readiness', () => {
	it('is ready before the file exists, or the first save could never create it', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell().shell);

		const target = await desktop.connect({ kv: memKv(), fileName: 'app.zip' });

		expect(await target?.isReady()).toBe(true);
	});

	it('moves the destination when the user re-picks, and remembers the new path', async () => {
		const { desktop } = await freshModules();
		let asked = 0;
		const { shell } = fakeShell({
			async save() {
				asked += 1;
				return asked === 1 ? 'C:/old/app.zip' : 'D:/new/app.zip';
			}
		});
		desktop.useDesktopFiles(shell);
		const kv = memKv();

		const target = await desktop.connect({ kv, fileName: 'app.zip' });
		expect(target?.label).toBe('app.zip');

		expect(await target?.reconnect()).toBe(true);
		expect(await kv.get('desktopFilePath')).toBe('D:/new/app.zip');

		await target?.save(new Blob([new Uint8Array([9])]));
		expect([...(await shell.readFile('D:/new/app.zip'))]).toEqual([9]);
	});

	it('keeps the current file when the re-pick is cancelled', async () => {
		const { desktop } = await freshModules();
		let asked = 0;
		desktop.useDesktopFiles(
			fakeShell({
				async save() {
					asked += 1;
					return asked === 1 ? 'C:/old/app.zip' : null;
				}
			}).shell
		);
		const kv = memKv();

		const target = await desktop.connect({ kv, fileName: 'app.zip' });

		expect(await target?.reconnect()).toBe(false);
		expect(await kv.get('desktopFilePath')).toBe('C:/old/app.zip');
	});

	it('forgets the path on disconnect without touching the file', async () => {
		const { desktop } = await freshModules();
		const { shell, files } = fakeShell();
		desktop.useDesktopFiles(shell);
		const kv = memKv();

		const target = await desktop.connect({ kv, fileName: 'app.zip' });
		await target?.save(new Blob([new Uint8Array([1])]));
		await target?.disconnect();

		expect(await kv.get('desktopFilePath')).toBeUndefined();
		expect(files.has('C:/backups/app.zip')).toBe(true);
	});
});

describe('reopening', () => {
	it('rebuilds from the remembered path with nothing asked of the user', async () => {
		const { desktop } = await freshModules();
		const { shell } = fakeShell();
		desktop.useDesktopFiles(shell);
		const kv = memKv();
		await kv.set('desktopFilePath', 'C:/backups/cabinet.zip');

		const target = await desktop.fromSession({ kv });

		expect(target?.label).toBe('cabinet.zip');
		expect(await target?.isReady()).toBe(true);
	});

	it('rebuilds nothing when no path was ever kept', async () => {
		const { desktop } = await freshModules();
		desktop.useDesktopFiles(fakeShell().shell);

		expect(await desktop.fromSession({ kv: memKv() })).toBeNull();
	});
});

describe('the file destination defers to the shell', () => {
	it('claims support in a webview that ships no picker at all', async () => {
		const { desktop, file } = await freshModules();
		// WebKit: neither picker exists. Without the shell this is a hard no.
		vi.stubGlobal('window', {});
		expect(file.isSupported()).toBe(false);
		expect(file.isOpenSupported()).toBe(false);

		desktop.useDesktopFiles(fakeShell().shell);

		expect(file.isSupported()).toBe(true);
		expect(file.isOpenSupported()).toBe(true);
	});

	it('routes connect, open and reopen through the shell', async () => {
		const { desktop, file } = await freshModules();
		vi.stubGlobal('window', {});
		desktop.useDesktopFiles(fakeShell({ save: async () => 'C:/x/from-shell.zip' }).shell);
		const kv = memKv();

		const created = await file.connect({ kv, fileName: 'app.zip' });
		expect(created?.label).toBe('from-shell.zip');

		const opened = await file.openExisting({ kv });
		expect(opened?.label).toBe('app.zip');

		const reopened = await file.fromSession({ kv });
		expect(reopened?.label).toBe('app.zip');
	});
});
