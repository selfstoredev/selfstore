// The destination glyphs the connect cards fall back to when a host passes
// none. A card with no icon reads as unfinished, and every consuming app was
// solving that the same way: two image files of its own, copied from app to
// app, drifting in size and color.
//
// Deliberately NEUTRAL drawings, not brand marks. A provider logo is a
// trademark, and redistributing one inside a public package is a different
// question from an application displaying it to name an integration it
// actually offers. Shipping a cloud rather than a company's mark keeps every
// consumer clean by default; a host that has cleared the right to a real logo
// passes it through `icons` and wins.
//
// Inlined as data URIs: a library that promises the data stays put cannot
// fetch an image from a third party to draw its own screen.

import type { ConnectKind } from '../flows/connect';

/** One neutral gray that stays legible on a light and on a dark surface;
 *  an <img> cannot inherit the host's currentColor. */
const INK = '#8a8f98';

const svg = (body: string): string =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
	)}`;

/** A glyph per destination kind: a cloud for a hosted drive, a document for a
 *  file on the device, a server for WebDAV, a bucket for object storage. */
export const defaultIcons: Record<ConnectKind, string> = {
	drive: svg('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.2 3.9 3.9 0 0 0 7 18Z"/>'),
	file: svg(
		'<path d="M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7Z"/><path d="M14 3v4h4"/>'
	),
	webdav: svg(
		'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'
	),
	s3: svg(
		'<path d="M4.5 6h15l-1.4 13a2 2 0 0 1-2 1.8H7.9a2 2 0 0 1-2-1.8Z"/><path d="M4.5 6c0-1.1 3.4-2 7.5-2s7.5.9 7.5 2"/>'
	)
};
