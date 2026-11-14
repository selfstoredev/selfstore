import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backup } from './fluent';
import { BACKUP_EXTENSION } from './box';
import type { Snapshot } from './types';

vi.mock('./targets/local', () => ({
	pickSaveHandle: vi.fn().mockResolvedValue(null),
	downloadBlob: vi.fn(),
	writeToHandle: vi.fn()
}));

const sample: Snapshot = { collections: { notes: [{ id: '1', body: 'x' }] }, files: [] };

describe('BackupBuilder.toDisk fallback', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2024-01-15'));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('uses generated filename and returns true', async () => {
		const { downloadBlob } = await import('./targets/local');
		const mockDownload = vi.mocked(downloadBlob);
		const result = await backup(sample).as('my-app').toDisk();
		expect(result).toBe(true);
		expect(mockDownload).toHaveBeenCalledOnce();
		const [blob, name] = mockDownload.mock.calls[0];
		expect(blob).toBeInstanceOf(Blob);
		expect(name).toBe(`my-app-2024-01-15${BACKUP_EXTENSION}`);
	});

	it('uses provided filename when given', async () => {
		const { downloadBlob } = await import('./targets/local');
		const mockDownload = vi.mocked(downloadBlob);
		const result = await backup(sample).as('my-app').toDisk('custom.zip');
		expect(result).toBe(true);
		expect(mockDownload).toHaveBeenCalledOnce();
		const [blob, name] = mockDownload.mock.calls[0];
		expect(blob).toBeInstanceOf(Blob);
		expect(name).toBe('custom.zip');
	});
});
