// @vitest-environment node
/**
 * The capability-link transport codec: base64url round-trips, strict structural
 * validation (a decoder never returns a half-parsed object), and the version
 * guard. Pure, no crypto keys, no I/O.
 */
import { describe, expect, it } from 'vitest';
import {
	encodeShare,
	decodeShare,
	encodeAnnounce,
	decodeAnnounce,
	toCopyLink,
	randomId,
	HouseholdCodeError,
	type SharePayload,
	type AnnouncePayload
} from './codec';

const copy = (fileId: string, ownerEmail?: string) => ({
	provider: 'drive' as const,
	fileId,
	...(ownerEmail ? { ownerEmail } : {})
});

describe('household capability-link codec', () => {
	it('share payload round-trips through base64url', () => {
		const payload: SharePayload = {
			v: 1,
			mailboxId: 'mbox-123',
			roster: [copy('admin-file', 'admin@x.fr'), copy('bob-file')]
		};
		const back = decodeShare(encodeShare(payload));
		expect(back).toEqual(payload);
	});

	it('announce payload round-trips', () => {
		const payload: AnnouncePayload = { v: 1, copy: copy('my-file', 'me@x.fr') };
		expect(decodeAnnounce(encodeAnnounce(payload))).toEqual(payload);
	});

	it('roster is de-duplicated by fileId (first wins)', () => {
		const code = encodeShare({
			v: 1,
			mailboxId: 'm',
			roster: [copy('dup', 'first@x.fr'), copy('dup', 'second@x.fr'), copy('other')]
		});
		const roster = decodeShare(code).roster;
		expect(roster.map((l) => l.fileId)).toEqual(['dup', 'other']);
		expect(roster[0].ownerEmail).toBe('first@x.fr');
	});

	it('a copy link keeps EXACTLY its known keys (no smuggled extras)', () => {
		const link = toCopyLink({ provider: 'drive', fileId: 'f', ownerEmail: 'e', junk: 'nope' });
		expect(link).toEqual({ provider: 'drive', fileId: 'f', ownerEmail: 'e' });
	});

	it('rejects an unknown copy-link provider and a missing fileId', () => {
		expect(() => toCopyLink({ provider: 'webdav', fileId: 'f' })).toThrow(HouseholdCodeError);
		expect(() => toCopyLink({ provider: 'drive' })).toThrow(/string fileId/);
	});

	it('rejects a wrong-kind or malformed code, whole (never half-parsed)', () => {
		expect(() => decodeShare('not-base64url!!!')).toThrow(HouseholdCodeError);
		expect(() => decodeShare(encodeAnnounce({ v: 1, copy: copy('x') }))).toThrow(/mailboxId/);
		expect(() => decodeShare('')).toThrow(/non-empty/);
	});

	it('flags a future version distinctly from garbage', () => {
		const future = btoa(JSON.stringify({ v: 2, mailboxId: 'm', roster: [] }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(() => decodeShare(future)).toThrow(/not supported/);
		try {
			decodeShare(future);
		} catch (e) {
			expect((e as HouseholdCodeError).code).toBe('unsupported-version');
		}
	});

	it('randomId is short, url-safe and unique', () => {
		const a = randomId();
		const b = randomId();
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
	});
});
