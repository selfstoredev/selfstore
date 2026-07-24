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
			exclude: ['**/*.test.ts', '**/*.d.ts'],
			// Ratchet floors, set just under the measured baseline. They only
			// ever move UP: when coverage rises, raise them in the same commit.
			// Never lower them to pass.
			thresholds: {
				statements: 78.5,
				branches: 74.2,
				functions: 73.5,
				lines: 81.5
			}
		}
	}
});
