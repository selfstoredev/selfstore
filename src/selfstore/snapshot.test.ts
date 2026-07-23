import { describe, it, expect } from 'vitest';
import { exportSnapshot, importSnapshot, isEncrypted, type Snapshot } from './index';

function sample(): Snapshot {
	return {
		collections: {
			items: [
				{ id: 'a1', name: 'first', value: 1234.56 },
				{ id: 'a2', name: 'second', value: 9000 }
			],
			notes: [{ id: 'l1', body: 'hello' }]
		},
		files: [
			{
				id: 'f1',
				name: 'doc.pdf',
				mime: 'application/pdf',
				bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5])
			}
		]
	};
}

describe('snapshot export/import', () => {
	it('round-trips collections and binary files without a password', async () => {
		const snap = sample();
		const blob = await exportSnapshot(snap, { app: 'test-app' });
		expect(await isEncrypted(blob)).toBe(false);

		const back = await importSnapshot(blob);
		expect(back.collections).toEqual(snap.collections);
		expect(back.files).toHaveLength(1);
		expect(back.files[0].name).toBe('doc.pdf');
		expect(back.files[0].bytes).toEqual(snap.files[0].bytes);
	});

	it('round-trips encrypted, and refuses the wrong password', async () => {
		const snap = sample();
		const blob = await exportSnapshot(snap, { app: 'test-app', password: 's3cret' });
		expect(await isEncrypted(blob)).toBe(true);

		const back = await importSnapshot(blob, { password: 's3cret' });
		expect(back.collections).toEqual(snap.collections);
		expect(back.files[0].bytes).toEqual(snap.files[0].bytes);

		await expect(importSnapshot(blob, { password: 'guess' })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
	});

	it('an unencrypted backup is a plain ZIP', async () => {
		const blob = await exportSnapshot(sample(), { app: 'test-app' });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		// The file itself starts with the ZIP local-file-header signature "PK\x03\x04".
		expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
	});
});
