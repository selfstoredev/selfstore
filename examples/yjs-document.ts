/**
 * A Yjs document carried by selfstore.
 *
 * selfstore's own merge is last-write-wins: a concurrent edit to one record
 * keeps the later clock and the losing value is reported, not merged. For text
 * two people type into at once, that is the wrong answer - you want a real
 * sequence CRDT. You do not have to choose: keep the CRDT for the document and
 * let selfstore do what it is good at around it - IndexedDB working copy,
 * end-to-end encrypted backup, destinations the user owns, no server.
 *
 * The whole trick is in HOW the document is stored. Yjs updates are
 * commutative and idempotent - apply them in any order, apply one twice, you
 * land on the same document - and selfstore's file merge is a union by id.
 * Store each update under the id of its own bytes and the union IS the CRDT
 * merge: every device's updates survive meeting, and folding them is the whole
 * of the read path.
 *
 * The trap is the other way round: ONE stable id for the whole document. Two
 * devices editing offline then write different bodies under one id, the union
 * keeps one of them, and the other device's work is gone with no conflict
 * reported - files have no clock to be ordered by. `putFile` refuses that by
 * default; this example never names an id at all.
 */
import * as Y from 'yjs';
import { selfstore } from '../src/index';

/** Marks the files that are this document's updates, so other attachments
 *  (an image, an export) are left alone. */
const UPDATE_MIME = 'application/x-yjs-update';

/** Fold beyond this many updates. Purely a size concern - see compact(). */
const COMPACT_AT = 50;

/** Tag for updates we applied ourselves, so echoing them back to the store is
 *  skipped. Yjs hands the origin to every update listener. */
const FOLDED = Symbol('folded');

export async function run() {
	const store = await selfstore('notes-with-crdt');
	const doc = new Y.Doc();
	const body = doc.getText('body');

	const updateFiles = () => store.allFiles().filter((f) => f.mime === UPDATE_MIME);

	/** Fold everything the store currently holds into the document. Applying an
	 *  update the document already has changes nothing and emits nothing, so
	 *  this is safe to run on every change, however often. */
	const fold = (): void => {
		for (const f of updateFiles()) Y.applyUpdate(doc, f.bytes, FOLDED);
	};

	// 1. The read path: whatever this device had, plus whatever arrived.
	fold();

	// 2. The write path. Every local edit becomes one more immutable update,
	//    under the id of its own bytes - never a stable id (see the header).
	doc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin === FOLDED) return; // came from the store; storing it again is noise
		void store.putFile({ bytes: update, mime: UPDATE_MIME, name: 'body.yupdate' });
	});

	// 3. Another device's updates arrive through the ordinary merge - a sync, a
	//    restore, another tab. onChange fires, and folding them is all it takes.
	store.onChange(fold);

	// 4. From here it is a normal selfstore app.
	await store.connectFile(); // or connectDrive / connectWebdav / connectS3
	await store.protect('a passphrase the user chose');

	body.insert(0, 'typed on this device');
	return { doc, body, compact: () => compact(store, doc) };
}

/**
 * Best-effort garbage collection: replace the accumulated updates with a
 * single equivalent one.
 *
 * Correctness never depends on this. It is worth knowing that it does not
 * converge either: file deletions are local, so a device that was offline
 * still holds the old updates and the next union brings them back, until every
 * device has seen the compacted state. Nothing is lost when that happens - the
 * old updates simply fold in again and land on the same document.
 */
async function compact(store: Awaited<ReturnType<typeof selfstore>>, doc: Y.Doc): Promise<void> {
	const updates = store.allFiles().filter((f) => f.mime === UPDATE_MIME);
	if (updates.length < COMPACT_AT) return;

	// Encoding the document's whole state is equivalent to merging its updates,
	// and it is what the document already holds in memory.
	const merged = Y.encodeStateAsUpdate(doc);
	const keep = await store.putFile({ bytes: merged, mime: UPDATE_MIME, name: 'body.yupdate' });
	for (const f of updates) if (f.id !== keep) await store.removeFile(f.id);
}
