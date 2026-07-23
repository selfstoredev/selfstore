/**
 * A backup round-trip with no store and no server: turn app data into an
 * encrypted file, then read it back. Runs in any browser; typechecked here so
 * the documented API can never drift from what compiles.
 */
import { backup, restore, type Snapshot } from '../src/index';

interface Note {
	id: string; // records are identified by a STRING id
	text: string;
}

export async function roundTrip(notes: Note[], password: string): Promise<Note[]> {
	const snap: Snapshot = { collections: { notes }, files: [] };

	// Fluent write: name the app, encrypt, get a Blob (or .toBytes() / .toDisk()).
	const blob = await backup(snap).as('notes-app', '1.0.0').encryptedWith(password).toBlob();

	// Peek without decrypting, then read the data back.
	if (!(await restore(blob).isEncrypted())) throw new Error('expected an encrypted backup');
	const back = await restore(blob).withPassword(password).read();
	return (back.collections.notes ?? []) as Note[];
}
