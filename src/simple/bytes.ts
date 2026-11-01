// A leaf on purpose: the proof entry needs these two and must not pull the
// whole store graph in with them.

/** What a file body may be handed in as. */
export type FileBytes = Uint8Array | ArrayBuffer | Blob;

/** Blob and ArrayBuffer are accepted because that is what a picker, a fetch and
 *  a canvas hand back; the snapshot only ever holds Uint8Array. */
export async function toBytes(input: FileBytes): Promise<Uint8Array> {
	// Copied: a file is stored under the hash of its bytes, and a caller writing
	// into a shared buffer later would change the file under that id.
	if (input instanceof Uint8Array) return input.slice();
	if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
	return new Uint8Array(await input.arrayBuffer());
}
