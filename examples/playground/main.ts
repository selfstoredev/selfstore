// The playground: the whole pitch in one screen, running the published package.
//
// Three things happen here, and none of them involves a server: the notes
// persist across reloads, the store can adopt a real file on the disk, and the
// download button hands over a genuine encrypted ZIP.

import { selfstore } from 'selfstore';
import { defineSelfstoreWidgets } from 'selfstore/widgets';

interface Note {
	id: string; // records need a string id: it is what the multi-device merge keys on
	text: string;
	[k: string]: unknown;
}

defineSelfstoreWidgets();

const store = await selfstore<{ notes: Note }>('playground');

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const notes = $<HTMLTextAreaElement>('notes');
const note = $<HTMLElement>('note');

// The status widget renders the store's headless status: saved, saving, or
// nowhere yet. No copy to write - it ships English and French.
($('status') as HTMLElement & { store: unknown }).store = store;

// --- read ---------------------------------------------------------------

const render = (): void => {
	const saved = store.get('notes', 'the-note');
	if (saved && saved.text !== notes.value) notes.value = saved.text;
};

// onChange fires for your writes, another tab, and another device.
store.onChange(render);
render();

// --- write --------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
notes.addEventListener('input', () => {
	clearTimeout(timer);
	// put() already debounces the save; this only keeps the store call cheap.
	timer = setTimeout(() => {
		void store.put('notes', { id: 'the-note', text: notes.value });
	}, 150);
});

// --- a real file on the disk --------------------------------------------

$('save-to-file').addEventListener('click', () => {
	void (async () => {
		try {
			const outcome = await store.connectFile();
			note.textContent =
				outcome === 'manual'
					? 'This browser cannot hold a file handle, so saving is a download each time.'
					: 'Connected. Every change now also writes to that file.';
		} catch (err) {
			note.textContent = 'Could not connect a file: ' + String(err);
		}
	})();
});

// --- a portable backup ---------------------------------------------------

$('download').addEventListener('click', () => {
	void (async () => {
		await store.protect('playground-password');
		const written = await store.downloadBackup();
		// False means the save dialog was dismissed: nothing was written, so
		// saying "backed up" would be a lie.
		note.textContent = written
			? 'Downloaded. It is a real ZIP, encrypted with "playground-password".'
			: 'Nothing was written - the dialog was closed.';
	})();
});
