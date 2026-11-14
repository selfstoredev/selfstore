import { describe, it, expect } from 'vitest';
import type { Snapshot, EncodeOptions } from './types';
import { EncryptedBackupBuilder } from './fluent';

describe('EncryptedBackupBuilder requires password', () => {
	it('throws TypeError when password is missing', () => {
		const snapshot: Snapshot = { collections: {}, files: [] };
		const opts: EncodeOptions = { app: 'test', appVersion: '1' };
		expect(() => new EncryptedBackupBuilder(snapshot, opts)).toThrow(
			'EncryptedBackupBuilder: a password is required - use backup(snapshot).as(app).encryptedWith(password)'
		);
	});
});
