// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickFromDisk } from './local';

describe('pickFromDisk', () => {
	let clickSpy: ReturnType<typeof vi.spyOn>;
	let appendChildSpy: ReturnType<typeof vi.spyOn>;
	let removeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
		appendChildSpy = vi.spyOn(document.body, 'appendChild');
		removeSpy = vi.spyOn(HTMLElement.prototype, 'remove');
	});

	it('resolves with the selected file when user picks one', async () => {
		const file = new File(['zip content'], 'backup.zip', { type: 'application/zip' });
		const input = document.createElement('input');
		input.type = 'file';
		Object.defineProperty(input, 'files', { value: [file] });

		const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(input);

		const promise = pickFromDisk();
		input.onchange?.(new Event('change'));
		const result = await promise;

		expect(result).toBe(file);
		expect(createElementSpy).toHaveBeenCalledWith('input');
		expect(input.type).toBe('file');
		expect(input.accept).toBe('.zip,application/zip,application/octet-stream');
		expect(input.style.display).toBe('none');
		expect(appendChildSpy).toHaveBeenCalledWith(input);
		expect(clickSpy).toHaveBeenCalled();
		expect(removeSpy).toHaveBeenCalled();

		createElementSpy.mockRestore();
	});

	it('resolves with null when user cancels the dialog', async () => {
		const input = document.createElement('input');
		input.type = 'file';

		const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(input);

		const promise = pickFromDisk();
		input.oncancel?.(new Event('cancel'));
		const result = await promise;

		expect(result).toBeNull();
		expect(createElementSpy).toHaveBeenCalledWith('input');
		expect(input.accept).toBe('.zip,application/zip,application/octet-stream');
		expect(appendChildSpy).toHaveBeenCalledWith(input);
		expect(clickSpy).toHaveBeenCalled();
		expect(removeSpy).toHaveBeenCalled();

		createElementSpy.mockRestore();
	});

	it('resolves with null when onchange fires with no files', async () => {
		const input = document.createElement('input');
		input.type = 'file';
		Object.defineProperty(input, 'files', { value: [] });

		const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(input);

		const promise = pickFromDisk();
		input.onchange?.(new Event('change'));
		const result = await promise;

		expect(result).toBeNull();
		createElementSpy.mockRestore();
	});
});
