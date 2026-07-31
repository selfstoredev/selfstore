/**
 * The destination names, shared by every widget that has to say WHERE the data
 * goes.
 *
 * They lived in the panel, and the header control needed the same five words.
 * Copying them would have been the ordinary way to do it, and the ordinary way
 * is how a lexicon drifts: two screens of the same app naming one target
 * differently, each correct on its own. One key, one wording, one place.
 */

import type { WidgetLabels } from './base';

export const EN: WidgetLabels = {
	'destination.kind.drive': 'Google Drive',
	'destination.kind.file': 'A file on this device',
	'destination.kind.webdav': 'Your own server',
	'destination.kind.s3': 'Your own bucket',
	'destination.kind.device': 'This device only',
	// A browser that cannot hold a writable file handle: the data is kept here
	// and a backup is written only when the user asks for one. It is a mode the
	// STORE itself falls back to, so the library owes it a name - without one, a
	// panel showed the raw key to the user.
	'destination.kind.file-manual': 'A file you download'
};

// A pack carries only what READS differently: `t()` falls back to the EN
// defaults, so a brand name repeated word for word would just be a second
// place to keep it in step.
export const FR: WidgetLabels = {
	'destination.kind.file': 'Un fichier sur cet appareil',
	'destination.kind.webdav': 'Votre serveur',
	'destination.kind.s3': 'Votre bucket',
	'destination.kind.device': 'Cet appareil seulement',
	'destination.kind.file-manual': 'Un fichier, par téléchargement'
};
