// The one Argon2id call, shared by the calling-thread fallback and the KDF
// worker so both derive byte-identical keys. On the calling thread hash-wasm
// loads dynamically - only when a password is actually used. The worker hands
// its own static import instead: esbuild cannot tree-shake a dynamic import of
// an inlined module, and the worker then shipped every hash-wasm algorithm.

import type { argon2id as Argon2id } from 'hash-wasm';
import { fromBase64 } from './base64';

/** AES-256 key length. */
export const KEY_BYTES = 32;

/** One key-derivation job (postMessage-friendly: plain fields only). */
export interface KdfJob {
	id: number;
	password: string;
	/** Base64, exactly as stored in the backup header. */
	salt: string;
	/** Memory cost in KiB. */
	m: number;
	/** Iterations (passes). */
	t: number;
	/** Parallelism (lanes). */
	p: number;
}

/** The worker's reply: the raw key, or the failure message. */
export interface KdfReply {
	id: number;
	key?: Uint8Array;
	error?: string;
}

/** Derive the key of one job with the given hash-wasm argon2id. */
export function deriveKey(argon2id: typeof Argon2id, job: KdfJob): Promise<Uint8Array> {
	return argon2id({
		password: job.password,
		salt: fromBase64(job.salt),
		parallelism: job.p,
		iterations: job.t,
		memorySize: job.m,
		hashLength: KEY_BYTES,
		outputType: 'binary'
	});
}

export async function runKdfJob(job: KdfJob): Promise<Uint8Array> {
	const { argon2id } = await import('hash-wasm');
	return deriveKey(argon2id, job);
}
