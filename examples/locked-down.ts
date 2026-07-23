/**
 * A locked-down deployment: the backup must live on storage the user controls,
 * must always be encrypted, and the password must be strong. selfstore enforces
 * all three at the store, so the app cannot forget a check - and by simply not
 * mounting the share/join widgets, the app ships with no sharing surface at all.
 */
import { selfstore, checkPasswordPolicy, type PasswordPolicy } from '../src/index';
import type { S3Config } from '../src/entries/advanced';

const policy: PasswordPolicy = {
	minLength: 12,
	requireUppercase: true,
	requireDigit: true,
	requireSymbol: true
};

export async function run(password: string, bucket: S3Config) {
	// requireEncryption: no plaintext backup ever leaves the device.
	// passwordPolicy: a weak password is refused at the store, not just the UI.
	const store = await selfstore('clinic-notes', {
		requireEncryption: true,
		passwordPolicy: policy
	});

	// Preview the same policy for a live hint before the user submits (the store
	// enforces it either way - this only spares a round-trip and shows why).
	const check = checkPasswordPolicy(password, policy);
	if (!check.ok) {
		throw new Error(`weak password, unmet: ${check.unmet.join(', ')}`);
	}

	// The only home offered is an S3 bucket the user controls - no Google, no
	// vendor broker, the browser signs each request itself. connectS3 attaches
	// it and, because requireEncryption is on, demands the password up front.
	await store.connectS3(bucket, { password });

	return store;
}
