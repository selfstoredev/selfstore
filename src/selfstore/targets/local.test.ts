// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { saveToDisk } from './local';

/**
 * The return value is the whole point: a host that records "backed up today"
 * after a cancelled save dialog tells the user they are safe when no file
 * exists, and the lie only surfaces the day they need the file.
 */

type PickerWindow = typeof globalThis & {
	showSaveFilePicker?: unknown;
};

const w = globalThis as PickerWindow;

afterEach(() => {
	delete w.showSaveFilePicker;
});

function picker(behaviour: () => unknown): void {
	w.showSaveFilePicker = behaviour;
}

describe('saveToDisk', () => {
	it('reports the write when the picker accepts', async () => {
		const chunks: Blob[] = [];
		picker(() => ({
			createWritable: async () => ({
				write: async (d: Blob) => void chunks.push(d),
				close: async () => undefined
			})
		}));
		await expect(saveToDisk(new Blob(['x']), 'a.zip')).resolves.toBe(true);
		expect(chunks).toHaveLength(1);
	});

	it('reports NO write when the user closes the picker', async () => {
		picker(() => {
			throw new DOMException('cancelled', 'AbortError');
		});
		await expect(saveToDisk(new Blob(['x']), 'a.zip')).resolves.toBe(false);
	});

	it('falls back to a download when the picker fails for another reason', async () => {
		picker(() => {
			throw new TypeError('no such method here');
		});
		// happy-dom carries the anchor path; reaching it at all is the assertion.
		await expect(saveToDisk(new Blob(['x']), 'a.zip')).resolves.toBe(true);
	});

	it('reports the write on the plain download path', async () => {
		await expect(saveToDisk(new Blob(['x']), 'a.zip')).resolves.toBe(true);
	});
});
