// Off-main-thread key derivation. Argon2id takes about a second at the
// default cost, which would jank every encrypted push and pull if it ran on
// the UI thread. One lazy dedicated worker, terminated after an idle window
// so its ~46 MiB of WASM memory is not held forever. Any failure to spawn,
// load, or answer falls back to the calling thread, which runs the exact
// same runKdfJob - the worker is a responsiveness optimization, never a
// correctness dependency.

import { runKdfJob, type KdfJob, type KdfReply } from './argon2';
import type { KdfParams } from './types';

// Generous: a wedged worker is rerun on the calling thread, and Argon2id at
// the default cost already takes a second or two on a phone.
const JOB_TIMEOUT_MS = 30_000;
const IDLE_TERMINATE_MS = 30_000;

interface Pending {
	job: KdfJob;
	resolve: (key: Uint8Array) => void;
	reject: (e: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
// Once the worker path fails (blocked, missing asset), stay on the calling
// thread for the rest of the session instead of failing again.
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function armIdleStop(): void {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		if (pending.size === 0 && worker) {
			worker.terminate();
			worker = null; // respawned on the next job
		}
	}, IDLE_TERMINATE_MS);
}

/** Abandon the worker and finish every queued job on the calling thread. */
function fallBack(): void {
	broken = true;
	worker?.terminate();
	worker = null;
	clearTimeout(idleTimer);
	for (const p of pending.values()) {
		clearTimeout(p.timer);
		runKdfJob(p.job).then(p.resolve, p.reject);
	}
	pending.clear();
}

function ensureWorker(): Worker | null {
	if (broken) return null;
	if (worker) return worker;
	if (typeof Worker === 'undefined') {
		broken = true; // Node, old runtimes
		return null;
	}
	try {
		// Bundlers (Vite, webpack 5, Rollup) detect this exact
		// `new Worker(new URL(...), import.meta.url)` shape to ship the worker
		// file as an asset - do not refactor it away.
		worker = new Worker(new URL('./kdf-worker.js', import.meta.url), {
			type: 'module',
			name: 'selfstore-kdf'
		});
	} catch {
		broken = true;
		return null;
	}
	worker.onmessage = (ev: MessageEvent<KdfReply>): void => {
		const reply = ev.data;
		const p = pending.get(reply.id);
		if (!p) return;
		pending.delete(reply.id);
		clearTimeout(p.timer);
		if (reply.key) p.resolve(reply.key);
		else p.reject(new Error(reply.error ?? 'key derivation failed in the worker'));
		armIdleStop();
	};
	// Script 404, parse error, CSP: rerun the queued jobs locally.
	worker.onerror = (): void => fallBack();
	return worker;
}

/** Derive the raw AES key for `kdf`, off the main thread when possible. */
export function deriveRaw(password: string, kdf: KdfParams): Promise<Uint8Array> {
	const job: KdfJob = { id: ++seq, password, salt: kdf.salt, m: kdf.m, t: kdf.t, p: kdf.p };
	const w = ensureWorker();
	if (!w) return runKdfJob(job);
	return new Promise<Uint8Array>((resolve, reject) => {
		const timer = setTimeout(() => {
			// fallBack() clears every OTHER pending timer, so no job runs twice.
			pending.delete(job.id);
			fallBack();
			runKdfJob(job).then(resolve, reject);
		}, JOB_TIMEOUT_MS);
		pending.set(job.id, { job, resolve, reject, timer });
		w.postMessage(job);
	});
}
