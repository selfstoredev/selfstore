import { defineConfig } from 'vitest/config';

// The library is framework-agnostic and its tests run in plain Node: native
// WebCrypto powers the .selfstore round-trips, and the store test drives an
// in-memory cache + a fake target (no IndexedDB needed).
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		// The password-envelope suites derive real Argon2id keys (46 MiB, 3
		// passes) per slot; on a loaded machine that blows the 5s default and
		// reads as a fake failure. CI runners are unaffected.
		testTimeout: 60_000,
		coverage: {
			provider: 'v8',
			reporter: ['text-summary', 'lcov'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			// `*.testkit.ts` is a helper a suite imports, in the same category as
			// the suites themselves: it ships in no entry point and no consumer can
			// reach it. Measuring it would report on the instrument rather than on
			// the product - its unused branches exist for source shapes this
			// codebase does not currently write, and deleting them to chase a
			// percentage would make the reader worse.
			exclude: ['**/*.test.ts', '**/*.testkit.ts', '**/*.d.ts'],
			// Ratchet floors, set just under the measured baseline. They only
			// ever move UP: when coverage rises, raise them in the same commit.
			// Never lower them to pass.
			thresholds: {
				statements: 86.5,
				branches: 80.0,
				functions: 83.5,
				lines: 89.0
			}
		}
	}
});
