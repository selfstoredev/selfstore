// Worker entry, built self-contained into dist/kdf-worker.js (hash-wasm
// bundled in) so any bundler can ship it as a plain asset. One KdfJob in,
// one KdfReply out, key transferred rather than copied. The static named
// import is what keeps the other hash-wasm algorithms out of the bundle;
// scripts/worker-size.mjs holds it after every build.

import { argon2id } from 'hash-wasm';
import { deriveKey, type KdfJob, type KdfReply } from './argon2';

// globalThis === self inside a worker; typed via the WebWorker lib.
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<KdfJob>): Promise<void> => {
	const job = ev.data;
	try {
		const key = await deriveKey(argon2id, job);
		const reply: KdfReply = { id: job.id, key };
		scope.postMessage(reply, [key.buffer as ArrayBuffer]);
	} catch (e) {
		const reply: KdfReply = { id: job.id, error: e instanceof Error ? e.message : String(e) };
		scope.postMessage(reply);
	}
};
