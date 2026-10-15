// One way to call a notary over HTTP, so every adapter maps the same failures
// to the same codes: unreachable, overloaded or rate-limited is worth a retry,
// any other refusal is not.

import { SelfstoreError } from '../selfstore/errors';

/** Fetch `url`, throwing NOTARY_UNAVAILABLE or NOTARY_REFUSED instead of returning a failure. */
export async function reach(
	send: typeof fetch,
	url: string,
	init: RequestInit | undefined,
	who: string
): Promise<Response> {
	let response: Response;
	try {
		response = await send(url, init);
	} catch (e) {
		throw new SelfstoreError(
			'NOTARY_UNAVAILABLE',
			`${who} could not be reached: ${(e as Error).message}`
		);
	}
	if (!response.ok) {
		const code =
			response.status >= 500 || response.status === 429 ? 'NOTARY_UNAVAILABLE' : 'NOTARY_REFUSED';
		throw new SelfstoreError(code, `${who} answered ${response.status}`);
	}
	return response;
}
