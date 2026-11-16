import { describe, it, expect } from 'vitest';
import { writeBox } from './box';
import type { Snapshot } from './types';

describe('writeBox mutual exclusivity', () => {
	it('throws TypeError when both envelope and password are provided', async () => {
		const snapshot: Snapshot = { collections: {}, files: [] };
		const opts = {
			app: 'test',
			envelope: { dataKey: new Uint8Array(32), slots: [] },
			password: 'secret'
		};
		await expect(writeBox(snapshot, opts)).rejects.toThrow(
			new TypeError('writeBox(): `envelope` and `password` are mutually exclusive.')
		);
	});
});
