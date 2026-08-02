// SHA-256, hex. A leaf on purpose: three callers need it and none of them
// should have to pull in the other two's module graph.

/** Lowercase hex of arbitrary bytes. */
export function hex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/**
 * Lowercase hex SHA-256. Three meanings, one function: the digest that tells
 * two saves apart, the payload hash SigV4 signs, and the CONTENT ID a file
 * gets when the app does not name one - which is what keeps different bytes on
 * different ids, where the merge's union by id can keep both.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}
