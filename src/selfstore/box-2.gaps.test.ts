import { describe, it, expect } from 'vitest';
import { writeBox } from './box';
import type { EncodeOptions, Snapshot } from './types';
import { MAX_KEY_SLOTS, mintSlot } from './crypto';
import type { BoxEnvelope } from './box';

const snapshot: Snapshot = { collections: { accounts: [], persons: [] }, files: [] };

describe('writeBox envelope slot validation', () => {
	it('throws TypeError for empty slots', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const envelope: BoxEnvelope = { dataKey, slots: [] };
		const opts: EncodeOptions = {
			app: 'test',
			appVersion: '1',
			schemaVersion: 1,
			envelope
		};
		await expect(writeBox(snapshot, opts)).rejects.toThrow(
			new TypeError(`writeBox(): between 1 and ${MAX_KEY_SLOTS} password slots.`)
		);
	});

	it('throws TypeError for too many slots', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slots = await Promise.all(
			Array.from({ length: MAX_KEY_SLOTS + 1 }, () => mintSlot('password', dataKey))
		);
		const envelope: BoxEnvelope = { dataKey, slots };
		const opts: EncodeOptions = {
			app: 'test',
			appVersion: '1',
			schemaVersion: 1,
			envelope
		};
		await expect(writeBox(snapshot, opts)).rejects.toThrow(
			new TypeError(`writeBox(): between 1 and ${MAX_KEY_SLOTS} password slots.`)
		);
	});
});
