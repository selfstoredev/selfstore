// The two destinations that reach a server the user runs - WebDAV and an
// S3-compatible bucket - loaded on the gesture that uses them instead of with
// the module that offers them.
//
// Why these two and not all four: Drive and the disk file both open a picker or
// a consent popup, and a browser only allows that inside the transient
// activation of the user's click. An `await import()` before the call can spend
// that activation and turn a working button into a silently blocked popup. A
// WebDAV or S3 connection is plain fetch behind a form the user already
// submitted - nothing to preserve, so the chunk can arrive late.
//
// What it buys: an app that offers Drive and a disk file - the common case -
// stops shipping the SigV4 request signer and the WebDAV client. Before this,
// importing the connect journey (so: any of the widgets) pulled both in whether
// or not the app named them, which made "destinations are opt-in" true of the
// API and false of the bytes.
//
// `selfstore/advanced` keeps its STATIC `webdavTarget` / `s3Target`: naming one
// of those is the opt-in, and an app that wrote the import wants the code.

import { SelfstoreError } from '../../selfstore/errors';
import type { BackupTarget } from '../target';
import type { KV } from '../cache';
import type { WebdavConnectOptions } from './webdav';
import type { S3ConnectOptions } from './s3';

/** A chunk that does not arrive is the destination not answering: same code,
 *  same retry, rather than a bare Error escaping a public path. */
async function load<T>(what: string, mod: () => Promise<T>): Promise<T> {
	try {
		return await mod();
	} catch (e) {
		throw new SelfstoreError(
			'TARGET_UNAVAILABLE',
			`The ${what} support could not be loaded (${e instanceof Error ? e.message : String(e)}).`
		);
	}
}

export async function webdavConnect(opts: WebdavConnectOptions): Promise<BackupTarget | null> {
	return (await load('WebDAV', () => import('./webdav'))).connect(opts);
}

export async function webdavFromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	return (await load('WebDAV', () => import('./webdav'))).fromSession(opts);
}

export async function s3Connect(opts: S3ConnectOptions): Promise<BackupTarget | null> {
	return (await load('S3', () => import('./s3'))).connect(opts);
}

export async function s3FromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	return (await load('S3', () => import('./s3'))).fromSession(opts);
}
