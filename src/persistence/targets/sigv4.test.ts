// The signer is pinned to AWS's own documented example ("GET Object" from the
// Signature Version 4 test suite): same inputs must reproduce the published
// signature byte for byte, or the request would be rejected by every S3 server.

import { describe, it, expect } from 'vitest';
import { signS3, encodeS3Path, sha256Hex, EMPTY_PAYLOAD_SHA256 } from './sigv4';

describe('signS3', () => {
	it('reproduces the AWS documented GET Object signature', async () => {
		const signed = await signS3({
			method: 'GET',
			origin: 'https://examplebucket.s3.amazonaws.com',
			path: '/test.txt',
			region: 'us-east-1',
			accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
			secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			payloadHashHex: EMPTY_PAYLOAD_SHA256,
			extraHeaders: { range: 'bytes=0-9' },
			amzDate: '20130524T000000Z'
		});

		expect(signed.url).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
		expect(signed.headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
				'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
				'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
		);
		// Host is signed but never sent (the browser owns that header).
		expect(signed.headers.host).toBeUndefined();
		expect(signed.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
		expect(signed.headers['x-amz-date']).toBe('20130524T000000Z');
	});

	it('encodes each path segment but keeps the separators', () => {
		expect(encodeS3Path('/my bucket/a+b (1).txt')).toBe('/my%20bucket/a%2Bb%20%281%29.txt');
	});

	it('hashes the empty payload to the documented constant', async () => {
		expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_PAYLOAD_SHA256);
	});
});
