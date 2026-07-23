import { defineConfig } from 'vitest/config';

// The library is framework-agnostic and its tests run in plain Node: native
// WebCrypto powers the .selfstore round-trips, and the store test drives an
// in-memory cache + a fake target (no IndexedDB needed).
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
