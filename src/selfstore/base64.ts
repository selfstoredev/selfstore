/**
 * Base64 <-> bytes, shared by the crypto layer and the KDF worker (the worker
 * bundle must not drag the whole crypto module in for two helpers).
 */

export function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
