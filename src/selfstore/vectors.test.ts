/// <reference types="node" />
/**
 * Format-stability pin: the committed test vectors in spec/vectors/ (fixed
 * artifacts an independent reader tests against - see spec/selfstore_reader.py)
 * must keep reading with the current library. If a format change breaks these,
 * it breaks every backup already written; regenerate them only on purpose
 * (node spec/generate-vectors.mjs) and review the diff.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importSnapshot, inspect } from './index';
import { readBoxWithSync } from './box';
import type { GroupIdentity } from './group';

const vectors = join(dirname(fileURLToPath(import.meta.url)), '../../spec/vectors');
const manifest = JSON.parse(readFileSync(join(vectors, 'manifest.json'), 'utf8')) as {
	password: string;
	app: string;
	expected: {
		collections: Record<string, unknown[]>;
		files: { id: string; name: string; text: string }[];
	};
	files: Record<
		string,
		{
			encryption: string;
			format?: number;
			keying?: string;
			passwords?: string[];
			external?: { secretB64: string; keyRef: string };
			hasSyncJson: boolean;
		}
	>;
	group: { author: string; identities: Record<string, GroupIdentity> };
};

describe('committed format vectors still read', () => {
	for (const [name, props] of Object.entries(manifest.files)) {
		it(`${name} (${props.keying ?? props.encryption})`, async () => {
			const bytes = new Uint8Array(readFileSync(join(vectors, name)));
			const header = await inspect(bytes);
			expect(header.app).toBe(manifest.app);
			expect(header.encryption).toBe(props.encryption);
			if (props.format) expect(header.format).toBe(props.format);

			if (props.keying) {
				// Group vector: every committed recipient identity must open it and
				// see the verified author.
				const authorKey = manifest.group.identities[manifest.group.author].sigPub;
				expect(header.keying).toBe(props.keying);
				for (const identity of Object.values(manifest.group.identities)) {
					const r = await readBoxWithSync(bytes, undefined, { identity, authors: [authorKey] });
					expect(r.author).toBe(authorKey);
					expect(r.snapshot.collections).toEqual(manifest.expected.collections);
				}
				return;
			}

			// An envelope lists several password slots: every one must open the file.
			const passwords =
				props.encryption === 'none' ? [undefined] : (props.passwords ?? [manifest.password]);
			for (const password of passwords) {
				const snap = await importSnapshot(bytes, { password });
				expect(snap.collections).toEqual(manifest.expected.collections); // no __store leak
				for (const ef of manifest.expected.files) {
					const f = snap.files.find((x) => x.id === ef.id)!;
					expect(new TextDecoder().decode(f.bytes)).toBe(ef.text);
				}
			}

			// An external-key slot (SPEC 13.7): the committed secret opens the same
			// file through the resolver, exactly as the Python reader proves it does.
			if (props.external) {
				const secret = new Uint8Array(Buffer.from(props.external.secretB64, 'base64'));
				const r = await readBoxWithSync(bytes, undefined, undefined, undefined, async () => secret);
				expect(r.snapshot.collections).toEqual(manifest.expected.collections);
			}
		});
	}
});
