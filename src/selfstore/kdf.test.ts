/**
 * The KDF dispatcher: byte-identical keys on either path, and every failure
 * mode of the worker (missing, refused constructor, load error, wedged) falls
 * back to the calling thread - the worker is an optimization, never a
 * dependency. A fake Worker global stands in for the browser; the real worker
 * entry is ten lines over the same runKdfJob exercised here, and the existing
 * crypto KAT pins the primitive itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runKdfJob, type KdfJob, type KdfReply } from './argon2';
import type { KdfParams } from './types';

const KDF: KdfParams = {
	algo: 'argon2id',
	salt: 'AgICAgICAgICAgICAgICAg==', // 16 x 0x02
	m: 256, // small on purpose: the tests must be fast, equality is what matters
	t: 3,
	p: 1
};

/** Fresh dispatcher per test: the module keeps a worker singleton and a sticky
 *  broken flag, exactly the state under test. */
async function freshDeriveRaw(): Promise<
	(password: string, kdf: KdfParams) => Promise<Uint8Array>
> {
	vi.resetModules();
	return (await import('./kdf')).deriveRaw;
}

const inline = (password: string): Promise<Uint8Array> =>
	runKdfJob({ id: 0, password, salt: KDF.salt, m: KDF.m, t: KDF.t, p: KDF.p });

/** A Worker double that runs jobs through the REAL runKdfJob and replies like
 *  the worker entry does. */
function workingWorkerClass(posted: KdfJob[] = []) {
	return class FakeWorker {
		onmessage: ((ev: { data: KdfReply }) => void) | null = null;
		onerror: ((ev: unknown) => void) | null = null;
		postMessage(job: KdfJob): void {
			posted.push(job);
			void runKdfJob(job).then(
				(key) => this.onmessage?.({ data: { id: job.id, key } }),
				(e) => this.onmessage?.({ data: { id: job.id, error: String(e) } })
			);
		}
		terminate(): void {}
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('kdf dispatcher', () => {
	it('derives on the calling thread when no Worker global exists (Node)', async () => {
		const deriveRaw = await freshDeriveRaw(); // node: typeof Worker === 'undefined'
		expect(await deriveRaw('pw', KDF)).toEqual(await inline('pw'));
	});

	it('the worker path returns byte-identical keys', async () => {
		const posted: KdfJob[] = [];
		vi.stubGlobal('Worker', workingWorkerClass(posted));
		const deriveRaw = await freshDeriveRaw();
		expect(await deriveRaw('pw', KDF)).toEqual(await inline('pw'));
		expect(posted).toHaveLength(1); // it really went through the worker
	});

	it('falls back for good when construction throws (CSP), constructing once', async () => {
		let constructions = 0;
		class Refused {
			constructor() {
				constructions++;
				throw new Error('worker-src blocked');
			}
		}
		vi.stubGlobal('Worker', Refused);
		const deriveRaw = await freshDeriveRaw();
		expect(await deriveRaw('pw', KDF)).toEqual(await inline('pw'));
		expect(await deriveRaw('other', KDF)).toEqual(await inline('other'));
		expect(constructions).toBe(1); // broken is sticky: no retry storm
	});

	it('a load error (asset 404) reruns the queued job on the calling thread', async () => {
		class NeverLoads {
			onmessage: unknown = null;
			onerror: ((ev: unknown) => void) | null = null;
			postMessage(_job: KdfJob): void {
				// The script never loaded: the browser fires the error event instead
				// of ever answering.
				queueMicrotask(() => this.onerror?.(new Event('error')));
			}
			terminate(): void {}
		}
		vi.stubGlobal('Worker', NeverLoads);
		const deriveRaw = await freshDeriveRaw();
		expect(await deriveRaw('pw', KDF)).toEqual(await inline('pw')); // resolved by the fallback
	});

	it('a wedged worker times out and the job completes on the calling thread', async () => {
		class Wedged {
			onmessage: unknown = null;
			onerror: unknown = null;
			postMessage(): void {} // swallows the job forever, no error event
			terminate(): void {}
		}
		vi.stubGlobal('Worker', Wedged);
		vi.useFakeTimers();
		const deriveRaw = await freshDeriveRaw();
		const p = deriveRaw('pw', KDF);
		await vi.advanceTimersByTimeAsync(30_001); // the per-job timeout fires
		vi.useRealTimers();
		expect(await p).toEqual(await inline('pw'));
	});

	it('terminates the idle worker and respawns it on the next job', async () => {
		let constructions = 0;
		let terminated = 0;
		const Base = workingWorkerClass();
		class Counting extends Base {
			constructor() {
				super();
				constructions++;
			}
			terminate(): void {
				terminated++;
			}
		}
		vi.stubGlobal('Worker', Counting);
		vi.useFakeTimers();
		const deriveRaw = await freshDeriveRaw();
		await deriveRaw('pw', KDF);
		await vi.advanceTimersByTimeAsync(30_001); // idle window elapses
		expect(terminated).toBe(1); // the ~46 MiB WASM worker is not held forever
		await deriveRaw('pw', KDF); // and the next job just respawns it
		expect(constructions).toBe(2);
	});

	it('slot mint/open round-trip through the worker path', async () => {
		vi.stubGlobal('Worker', workingWorkerClass());
		vi.resetModules();
		const { mintSlot, openSlot } = await import('./crypto');
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintSlot('pw', dataKey);
		expect(await openSlot(slot, 'pw')).toEqual(dataKey);
	});
});
