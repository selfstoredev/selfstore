// AWS Signature Version 4 for S3 REST requests, in the browser with WebCrypto.
// Enough of the spec to sign one object's GET/PUT/HEAD - no streaming, no
// chunked upload, no presigned URLs. Works against AWS S3 and any S3-compatible
// endpoint (Cloudflare R2, Backblaze B2, MinIO) since they all verify SigV4.
//
// Signed headers are host, x-amz-content-sha256 and x-amz-date, plus whatever
// the caller adds. The browser sets Host itself from the URL and forbids
// overriding it, so we sign the host derived from that same URL - the value the
// browser will send - and never try to set the header.

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

/** SHA-256 of the empty body: the payload hash for every GET/HEAD. */
export const EMPTY_PAYLOAD_SHA256 =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

// RFC 3986 encoding, applied per path segment (the '/' between segments stays a
// separator). encodeURIComponent leaves !*'() alone; SigV4 requires them encoded.
function encodeSegment(s: string): string {
	return encodeURIComponent(s).replace(
		/[!*'()]/g,
		(c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
	);
}

/** Canonicalise an object path for both the request URL and the signature, so
 *  the two can never disagree on encoding. Pass the RAW key path (unencoded). */
export function encodeS3Path(path: string): string {
	return path
		.split('/')
		.map((seg) => encodeSegment(seg))
		.join('/');
}

export interface SignS3Input {
	method: string;
	/** Scheme + host(+port), e.g. https://s3.eu-west-3.amazonaws.com */
	origin: string;
	/** Raw (unencoded) object path, e.g. /my-bucket/backups/app.selfstore */
	path: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Hex SHA-256 of the request body (EMPTY_PAYLOAD_SHA256 for GET/HEAD). */
	payloadHashHex: string;
	/** Extra headers to sign, e.g. { range: 'bytes=0-0' }. Names are lowercased. */
	extraHeaders?: Record<string, string>;
	/** Basic timestamp (YYYYMMDDTHHMMSSZ). Injected in tests; defaults to now. */
	amzDate?: string;
	service?: string;
}

export interface SignedS3Request {
	/** The fully-encoded URL to fetch. */
	url: string;
	/** Headers to send: Authorization, x-amz-date, x-amz-content-sha256, extras. */
	headers: Record<string, string>;
}

/** ISO basic UTC now, YYYYMMDDTHHMMSSZ. */
function basicAmzDate(): string {
	return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** Sign one S3 request and return the URL plus the headers to send. */
export async function signS3(input: SignS3Input): Promise<SignedS3Request> {
	const service = input.service ?? 's3';
	const amzDate = input.amzDate ?? basicAmzDate();
	const dateStamp = amzDate.slice(0, 8);
	const { host } = new URL(input.origin);
	const canonicalUri = encodeS3Path(input.path);

	const headers: Record<string, string> = {
		host,
		'x-amz-content-sha256': input.payloadHashHex,
		'x-amz-date': amzDate
	};
	for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	const signedNames = Object.keys(headers).sort();
	const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n].trim()}\n`).join('');
	const signedHeaders = signedNames.join(';');

	const canonicalRequest = [
		input.method,
		canonicalUri,
		'', // no query string on any of our single-object requests
		canonicalHeaders,
		signedHeaders,
		input.payloadHashHex
	].join('\n');

	const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		scope,
		await sha256Hex(encoder.encode(canonicalRequest))
	].join('\n');

	const kDate = await hmac(
		encoder.encode('AWS4' + input.secretAccessKey),
		encoder.encode(dateStamp)
	);
	const kRegion = await hmac(kDate, encoder.encode(input.region));
	const kService = await hmac(kRegion, encoder.encode(service));
	const kSigning = await hmac(kService, encoder.encode('aws4_request'));
	const signature = hex(await hmac(kSigning, encoder.encode(stringToSign)));

	const authorization =
		`AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	// Send every signed header except host (the browser sets Host itself and
	// forbids overriding it - we signed the value it will send).
	const sendHeaders: Record<string, string> = { authorization };
	for (const n of signedNames) if (n !== 'host') sendHeaders[n] = headers[n];

	return { url: input.origin.replace(/\/$/, '') + canonicalUri, headers: sendHeaders };
}
