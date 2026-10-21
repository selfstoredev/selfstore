// Run after `npm run build`: dist/kdf-worker.js must carry Argon2id alone.
// A dynamic import of hash-wasm inside the worker once inlined all of its
// algorithms, 22 WebAssembly modules and 217 kB where two modules suffice.

import { readFileSync } from 'node:fs';

const WASM_MAGIC_BASE64 = 'AGFzbQ';
const MAX_MODULES = 2;

const worker = readFileSync(new URL('../dist/kdf-worker.js', import.meta.url), 'utf8');
const modules = worker.split(WASM_MAGIC_BASE64).length - 1;
if (modules < 1 || modules > MAX_MODULES) {
	console.error(
		`dist/kdf-worker.js carries ${modules} WebAssembly modules, expected 1 to ${MAX_MODULES}.`
	);
	process.exit(1);
}
console.log(`dist/kdf-worker.js: ${modules} WebAssembly modules, ${worker.length} bytes.`);
