import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KV } from '../cache';

interface FileHandle {
	name: string;
	createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
	getFile(): Promise<File>;
	queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
	requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
	isSameEntry?(other: FileHandle): Promise<boolean>;
}

function memKv(handle?: FileHandle): KV {
	const m = new Map<string, unknown>();
	if (handle) m.set('fileHandle', handle);
	return {
		async get<T>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k: string, v: unknown) {
			m.set(k, v);
		},
		async del(k: string) {
			m.delete(k);
		}
	};
}

function createMockHandle(overrides: Partial<FileHandle> = {}): FileHandle {
	return {
		name: 'test.zip',
		createWritable: vi.fn(),
		getFile: vi.fn(),
		queryPermission: vi.fn().mockResolvedValue('granted'),
		requestPermission: vi.fn().mockResolvedValue('granted'),
		isSameEntry: vi.fn().mockResolvedValue(true),
		...overrides
	};
}

async function getTarget(handle: FileHandle) {
	const { fromSession } = await import('./file');
	return fromSession({ kv: memKv(handle) });
}

describe('file target - permission methods', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('window', { showSaveFilePicker: vi.fn(), showOpenFilePicker: vi.fn() });
		vi.stubGlobal('navigator', { userActivation: { isActive: true } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		['granted', true],
		['prompt', false],
		['denied', false]
	] as const)('isReady returns %s for queryPermission=%s', async (state, expected) => {
		const handle = createMockHandle({ queryPermission: vi.fn().mockResolvedValue(state) });
		const target = await getTarget(handle);
		expect(await target!.isReady()).toBe(expected);
	});

	it.each([
		['granted', true],
		['prompt', false],
		['denied', false]
	] as const)('reconnect returns %s for requestPermission=%s', async (state, expected) => {
		const handle = createMockHandle({ requestPermission: vi.fn().mockResolvedValue(state) });
		const target = await getTarget(handle);
		expect(await target!.reconnect()).toBe(expected);
	});
});
