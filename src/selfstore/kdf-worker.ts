// Worker entry, built self-contained into dist/kdf-worker.js (hash-wasm
// bundled in) so any bundler can ship it as a plain asset. One KdfJob in,
// one KdfReply out, key transferred rather than copied.

import { runKdfJob, type KdfJob, type KdfReply } from './argon2';

// globalThis === self inside a worker; typed via the WebWorker lib.
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<KdfJob>): Promise<void> => {
	const job = ev.data;
	try {
		const key = await runKdfJob(job);
		const reply: KdfReply = { id: job.id, key };
		scope.postMessage(reply, [key.buffer as ArrayBuffer]);
	} catch (e) {
		const reply: KdfReply = { id: job.id, error: e instanceof Error ? e.message : String(e) };
		scope.postMessage(reply);
	}
};
