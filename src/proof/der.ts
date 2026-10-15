// The few DER shapes an RFC 3161 exchange needs, and no more. A timestamp
// request is five fields and the reply is read along one path, so a general
// ASN.1 library would be a fourth runtime dependency for two functions.

/** One decoded TLV: `start` and `end` bound its CONTENT. */
export interface DerNode {
	readonly tag: number;
	readonly start: number;
	readonly end: number;
}

export class DerError extends Error {}

function encodeLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** Encode one TLV around already-encoded content. */
export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const head = encodeLength(length);
	const out = new Uint8Array(1 + head.length + length);
	out[0] = tag;
	out.set(head, 1);
	let at = 1 + head.length;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Read the TLV that starts at `offset`. Indefinite lengths are BER, not DER: refused. */
export function readNode(bytes: Uint8Array, offset: number, limit = bytes.length): DerNode {
	if (offset + 2 > limit) throw new DerError('truncated header');
	const tag = bytes[offset];
	const first = bytes[offset + 1];
	let start = offset + 2;
	let length = first;
	if (first & 0x80) {
		const count = first & 0x7f;
		if (count === 0 || count > 4) throw new DerError('unsupported length');
		if (start + count > limit) throw new DerError('truncated length');
		length = 0;
		for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
		start += count;
	}
	const end = start + length;
	if (end > limit) throw new DerError('content runs past its parent');
	return { tag, start, end };
}

/** The direct children of a constructed node. */
export function childrenOf(bytes: Uint8Array, node: DerNode): DerNode[] {
	const out: DerNode[] = [];
	for (let at = node.start; at < node.end;) {
		const child = readNode(bytes, at, node.end);
		out.push(child);
		at = child.end;
	}
	return out;
}

/** The node's content, or a refusal when its tag is not the one expected. */
export function expectTag(node: DerNode | undefined, tag: number): DerNode {
	if (node?.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}`);
	return node;
}

export function contentOf(bytes: Uint8Array, node: DerNode): Uint8Array {
	return bytes.subarray(node.start, node.end);
}
