// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeAnnounce, decodeShare, toCopyLink, HouseholdCodeError } from './codec';

const encode = (text: string) =>
	btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const malformed = (message: string) => new HouseholdCodeError('malformed', message);
const drive = (extra: Record<string, unknown>) => ({
	provider: 'drive',
	fileId: 'file1',
	...extra
});

describe('household capability-link codec - malformed payloads', () => {
	it.each([
		['a missing version', { mailboxId: 'm', roster: [] }],
		['a version that is not a number', { v: '1', mailboxId: 'm', roster: [] }]
	])('refuses %s', (_, payload) => {
		expect(() => decodeShare(encode(JSON.stringify(payload)))).toThrowError(
			malformed('missing or non-numeric version field')
		);
	});

	it('refuses a payload that is not JSON', () => {
		expect(() => decodeShare(encode('not valid json'))).toThrowError(
			malformed('code payload is not valid JSON')
		);
	});

	it.each([
		['ownerEmail', 'copy link ownerEmail must be a string'],
		['ownerName', 'copy link ownerName must be a string']
	])('refuses a copy link whose %s is not a string', (field, message) => {
		const link = drive({ [field]: 123 });
		expect(() => toCopyLink(link)).toThrowError(malformed(message));
		expect(() => decodeAnnounce(encode(JSON.stringify({ v: 1, copy: link })))).toThrowError(
			malformed(message)
		);
		expect(() =>
			decodeShare(encode(JSON.stringify({ v: 1, mailboxId: 'm', roster: [link] })))
		).toThrowError(malformed(message));
	});
});
