import { defineConfig } from 'tsup';

// Two build units:
//  - the library: one ESM entry per public subpath ('.', './advanced',
//    './flows', './groups', './sync', './widgets') + types, sharing chunks between them; the runtime
//    deps (idb static, fflate/hash-wasm lazily imported) stay external so they
//    are not inlined and can be deduped by the consumer's bundler;
//  - the KDF worker: bundled self-contained (hash-wasm inlined, splitting off,
//    zero imports to resolve at runtime), so the
//    `new Worker(new URL('./kdf-worker.js', import.meta.url))` in kdf.ts can
//    load it as one plain asset from any bundler, or straight from dist.
export default defineConfig([
	{
		entry: {
			index: 'src/index.ts',
			advanced: 'src/entries/advanced.ts',
			backups: 'src/entries/backups.ts',
			flows: 'src/entries/flows.ts',
			groups: 'src/entries/groups.ts',
			households: 'src/entries/households.ts',
			sync: 'src/entries/sync.ts',
			widgets: 'src/entries/widgets.ts'
		},
		format: ['esm'],
		dts: true,
		clean: true,
		treeshake: true,
		sourcemap: true,
		target: 'es2022',
		external: ['fflate', 'hash-wasm', 'idb']
	},
	{
		entry: { 'kdf-worker': 'src/selfstore/kdf-worker.ts' },
		format: ['esm'],
		dts: false,
		clean: false,
		splitting: false,
		treeshake: true,
		sourcemap: true,
		target: 'es2022',
		platform: 'browser',
		noExternal: ['hash-wasm']
	}
]);
