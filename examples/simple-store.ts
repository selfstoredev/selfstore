/**
 * The simple store - selfstore's front door and the right starting point for
 * most apps. One call opens it, the store owns the data, and saving, syncing
 * and multi-device merging happen on their own. This file is the README quick
 * start, typechecked.
 */
import { selfstore, gisDriveAuth } from '../src/index';

interface Todo {
	id: string; // records need a string id: it is what the multi-device merge keys on
	title: string;
	done?: boolean;
	[k: string]: unknown;
}

export async function run() {
	// 1. Open the store. IndexedDB cache, auto-save and the browser sync
	//    moments (tab focus, network return, tab hide) are wired for you.
	const store = await selfstore<{ todos: Todo }>('todo-app');

	// 2. Read and write. Every mutation schedules a debounced save.
	await store.put('todos', { id: crypto.randomUUID(), title: 'ship it' });
	const open = store.all('todos').filter((t) => !t.done);

	// 3. Render on change - local writes AND merges arriving from other devices.
	store.onChange(() => render(store.all('todos')));

	// 4. Going further is one call each, whenever you are ready:
	//    multi-device sync (here Google Drive; connectFile/connectWebdav work alike)...
	await store.connectDrive(gisDriveAuth({ clientId: 'YOUR_GOOGLE_CLIENT_ID' }));
	//    ...end-to-end encryption of everything leaving the device...
	await store.protect('a passphrase the user chose');
	//    ...and a portable encrypted .zip the user can walk away with.
	await store.downloadBackup();

	// 5. Skin the built-in status ({ severity, action, labelKey }) yourself.
	console.log(store.status.labelKey); // e.g. 'status.synced' -> your copy, your language

	return open;
}

declare function render(todos: readonly Todo[]): void;
