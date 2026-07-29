// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { pickSaveHandle, saveToDisk, datedName } from './local';
import { backup } from '../index';

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

	it('treats a refused picker as no picker, not as a cancellation', async () => {
		// A browser that refuses for lack of user activation must not be read as
		// "the user said no": the backup still has to reach the disk somehow.
		picker(() => {
			throw new DOMException('Must be handling a user gesture', 'SecurityError');
		});
		await expect(pickSaveHandle('a.zip')).resolves.toBeNull();
	});

	it('reports a cancellation distinctly, so no download follows it', async () => {
		picker(() => {
			throw new DOMException('cancelled', 'AbortError');
		});
		await expect(pickSaveHandle('a.zip')).resolves.toBe('CANCELLED');
	});
});

describe('the order of the save dialog', () => {
	it('asks WHERE before building the blob', async () => {
		// The whole point: the dialog needs the click's transient activation, and
		// building an encrypted backup outlives it. If this order ever flips back,
		// browsers refuse the dialog and silently download instead.
		const ordre: string[] = [];
		picker(() => {
			ordre.push('dialogue');
			return {
				createWritable: async () => ({
					write: async () => void ordre.push('ecriture'),
					close: async () => undefined
				})
			};
		});

		const draft = backup({ collections: { notes: [{ id: 'n1' }] }, files: [] }).as('ordre-test');
		const original = draft.toBlob.bind(draft);
		draft.toBlob = async () => {
			ordre.push('blob');
			return original();
		};

		await expect(draft.toDisk('a.zip')).resolves.toBe(true);
		expect(ordre).toEqual(['dialogue', 'blob', 'ecriture']);
	});

	it('does not build the blob at all when the dialog is cancelled', async () => {
		const ordre: string[] = [];
		picker(() => {
			throw new DOMException('cancelled', 'AbortError');
		});
		const draft = backup({ collections: { notes: [{ id: 'n1' }] }, files: [] }).as('ordre-test');
		draft.toBlob = async () => {
			ordre.push('blob');
			return new Blob([]);
		};

		await expect(draft.toDisk('a.zip')).resolves.toBe(false);
		expect(ordre).toEqual([]);
	});
});

/**
 * The dated name exists for one reason: a download never replaces anything.
 * The browser appends " (1)", " (2)" whatever we do, and no web API can stop
 * it - so the pile may as well be readable.
 */
describe('datedName', () => {
	const quand = new Date(2026, 6, 26, 18, 42);

	it('stamps before the extension, to the minute', () => {
		expect(datedName('backup.zip', quand)).toBe('backup-2026-07-26-18h42.zip');
	});

	it('pads so the names sort in the order they were written', () => {
		// Without padding, "9h5" sorts after "10h30" and the pile stops being a
		// timeline - which is the only thing it had going for it.
		expect(datedName('a.zip', new Date(2026, 0, 3, 9, 5))).toBe('a-2026-01-03-09h05.zip');
	});

	it('handles a name without extension, and a dotfile', () => {
		expect(datedName('sauvegarde', quand)).toBe('sauvegarde-2026-07-26-18h42');
		expect(datedName('.hidden', quand)).toBe('.hidden-2026-07-26-18h42');
	});

	it('keeps a multi-dot name intact but for the last segment', () => {
		expect(datedName('mon.cabinet.zip', quand)).toBe('mon.cabinet-2026-07-26-18h42.zip');
	});
});
