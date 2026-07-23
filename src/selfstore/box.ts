// The portable backup container - a real ZIP in both cases, never a mystery
// blob:
//
//   unencrypted:  meta.json + selfstore.json + files/*   (browsable, format 1)
//   encrypted:    meta.json + data.enc + LISEZMOI.txt    (AES-256-GCM / Argon2id)
//
// Encrypted means the password envelope (format 3): a random data key seals
// the inner ZIP, wrapped once per password in keys[], and the exact meta.json
// bytes ride as GCM AAD so the slot table is tamper-evident. Format 2 is the
// passwordless group variant. Anything else is refused.

import type { Snapshot, Header, EncodeOptions, PasswordSlot, ExternalSlot, KeySlot } from './types';
import {
	buildEntries,
	entriesToSnapshot,
	readSidecar,
	pack,
	unpackWithSidecar,
	zip,
	unzip
} from './archive';
import {
	mintSlot,
	openSlot,
	openExternalSlot,
	MAX_KEY_SLOTS,
	gcmSealAad,
	gcmOpenAad,
	toBase64,
	fromBase64
} from './crypto';
import {
	GROUP_KEYING,
	gcmSealRaw,
	gcmOpenRaw,
	sealDataKey,
	openDataKey,
	signBox,
	verifyBox,
	type GroupIdentity
} from './group';
import { SelfstoreError } from './errors';

// Genuine ZIPs get the honest extension.
export const BACKUP_EXTENSION = '.zip';
export const BACKUP_MIME = 'application/zip';

const META = 'meta.json';
const DATA = 'data.enc';
const SIG = 'sig.bin';
const README = 'LISEZMOI.txt';

// Format identifier, which is also the discriminant: 1 plain ZIP, 2 group
// mode, 3 authenticated password envelope (header bound as GCM AAD). These are
// fixed wire ids; anything else is refused.
const BOX_FORMAT_PLAIN = 1;
const BOX_FORMAT_GROUP = 2;
const BOX_FORMAT_ENVELOPE_AUTH = 3;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

// Shipped inside encrypted backups for whoever opens the ZIP by hand. ASCII
// only so it renders in any viewer; apps brand it via EncodeOptions.readme.
const DEFAULT_README =
	'Encrypted backup / Sauvegarde chiffree\n\n' +
	'This is a valid ZIP archive.\n' +
	'"data.enc" holds your encrypted data (AES-256-GCM, key derived with Argon2id);\n' +
	'"meta.json" holds the decryption parameters (cleartext).\n' +
	'To read it, import this file into the application that created it\n' +
	'(named in meta.json) with your password.\n\n' +
	'Ce fichier est une archive ZIP valide.\n' +
	'"data.enc" contient vos donnees chiffrees (AES-256-GCM, cle derivee par Argon2id) ;\n' +
	'"meta.json" contient les parametres de dechiffrement (en clair).\n' +
	"Pour la lire, importez ce fichier dans l'application qui l'a creee\n" +
	'(nommee dans meta.json) avec votre mot de passe.\n';

/** Coerce an accepted input (a picked File, a fetched Blob, raw bytes) to bytes. */
export async function asBytes(input: Blob | Uint8Array): Promise<Uint8Array> {
	return input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
	return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

// An unknown cipher or per-slot KDF means a newer writer: UNSUPPORTED_VERSION,
// not a misleading DECRYPT_FAILED from feeding foreign params to AES-GCM.
function assertKnownCrypto(header: Header): void {
	if (header.encryption !== 'none' && header.encryption !== 'aes-256-gcm') {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Encryption "${header.encryption}" is newer than this reader supports.`
		);
	}
	if (header.keying !== undefined && header.keying !== GROUP_KEYING) {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Key envelope "${header.keying}" is newer than this reader supports.`
		);
	}
	for (const slot of header.keys ?? []) {
		// External slots carry no KDF (KEK comes from the caller's secret).
		if (!slot || (slot as ExternalSlot).kind === 'external') continue;
		if ((slot as PasswordSlot).kdf?.algo !== 'argon2id') {
			throw new SelfstoreError(
				'UNSUPPORTED_VERSION',
				`Key derivation "${(slot as PasswordSlot).kdf?.algo}" is newer than this reader supports.`
			);
		}
	}
}

/**
 * Serialize a snapshot to backup bytes. The optional `sidecar`
 * (createLocalStore's bookkeeping) rides its own sync.json entry - inside the
 * envelope when encrypting, so it never leaks in cleartext.
 */
export async function writeBox(
	snapshot: Snapshot,
	opts: EncodeOptions,
	sidecar?: unknown
): Promise<Uint8Array> {
	const header: Header = {
		format: BOX_FORMAT_PLAIN,
		app: opts.app,
		appVersion: opts.appVersion,
		schemaVersion: opts.schemaVersion,
		createdAt: new Date().toISOString(),
		encryption: 'none'
	};

	if (opts.group) {
		if (opts.password) {
			throw new TypeError('writeBox(): `group` and `password` are mutually exclusive.');
		}
		// Fresh data key enveloped once per recipient; the author's signature
		// covers the exact meta.json + data.enc bytes, so nothing a reader
		// trusts (recipients, author claim, iv, ciphertext) can be altered.
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const enc = await gcmSealRaw(dataKey, await pack(snapshot, sidecar));
		const meta: Header = {
			...header,
			format: BOX_FORMAT_GROUP,
			encryption: 'aes-256-gcm',
			keying: GROUP_KEYING,
			author: opts.group.sign.pub,
			recipients: await sealDataKey(dataKey, opts.group.recipients),
			iv: enc.iv
		};
		const metaBytes = utf8.enc.encode(JSON.stringify(meta));
		return zip(
			{
				[META]: metaBytes,
				[DATA]: enc.ciphertext,
				[SIG]: await signBox(metaBytes, enc.ciphertext, opts.group.sign.priv),
				[README]: utf8.enc.encode(opts.readme || DEFAULT_README)
			},
			0
		);
	}

	if (opts.envelope && opts.password) {
		throw new TypeError('writeBox(): `envelope` and `password` are mutually exclusive.');
	}

	if (opts.envelope || opts.password) {
		// A rewrite passes `envelope` (held data key + carried slot table) so a
		// writer that knows only one password preserves every other slot; a
		// plain `password` mints a fresh single-slot envelope, i.e. a data-key
		// rotation - that is what makes setEncryption actually revoke.
		// The iv is minted before meta.json is serialized so it sits inside the
		// AAD; seal and open then agree on the exact header bytes.
		const dataKey = opts.envelope?.dataKey ?? crypto.getRandomValues(new Uint8Array(32));
		const slots = opts.envelope?.slots ?? [await mintSlot(opts.password!, dataKey)];
		if (slots.length === 0 || slots.length > MAX_KEY_SLOTS) {
			throw new TypeError(`writeBox(): between 1 and ${MAX_KEY_SLOTS} password slots.`);
		}
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const meta: Header = {
			...header,
			format: BOX_FORMAT_ENVELOPE_AUTH,
			encryption: 'aes-256-gcm',
			keys: slots,
			iv: toBase64(iv)
		};
		const metaBytes = utf8.enc.encode(JSON.stringify(meta));
		const ciphertext = await gcmSealAad(dataKey, iv, await pack(snapshot, sidecar), metaBytes);
		return zip(
			{
				[META]: metaBytes,
				[DATA]: ciphertext,
				[README]: utf8.enc.encode(opts.readme || DEFAULT_README)
			},
			0
		);
	}

	// The file is the browsable archive: manifest + files (+ sync.json), plus meta.json.
	const entries = buildEntries(snapshot, sidecar);
	entries[META] = utf8.enc.encode(JSON.stringify(header));
	return zip(entries, 6);
}

/** Read the cleartext metadata (app, date, whether encrypted) without decrypting. */
export async function readBoxMeta(bytes: Uint8Array): Promise<Header> {
	if (!startsWith(bytes, ZIP_MAGIC)) {
		throw new SelfstoreError(
			'BAD_FORMAT',
			'Not a selfstore backup: expected a ZIP. Pass the exact bytes/Blob produced by ' +
				'backup().toBlob() / exportSnapshot(), not a decoded object.'
		);
	}
	return metaOf(await unzip(bytes));
}

/**
 * Group-mode read inputs: the reader's identity and the trusted author keys
 * (manifest members' Ed25519 publics). `authors` is mandatory - a valid
 * signature over an attacker-chosen author proves nothing (SPEC.md 12.6), so
 * there is no "decrypt without checking who signed" mode.
 */
export interface GroupReadOptions {
	identity: Pick<GroupIdentity, 'encPub' | 'encPriv'>;
	authors: string[];
}

/**
 * Key material captured at read time: the data key that opened the file plus
 * the slot table verbatim. Carried into rewrites so a session that knows only
 * one key preserves every slot.
 */
export interface BoxEnvelope {
	dataKey: Uint8Array;
	slots: KeySlot[];
}

/**
 * App-supplied secret fetch for an external-key slot (the WebAuthn/hardware
 * exchange lives app-side). Return null to skip the slot (wrong key, user
 * cancelled).
 */
export type ExternalKeyResolver = (slot: ExternalSlot) => Promise<Uint8Array | null>;

/**
 * Read a backup into a snapshot plus its sync.json sidecar (null when the
 * file carries none). Group copies need `group` and return the verified
 * author; envelope copies accept a held `dataKey` (KDF-free re-read) and
 * return the envelope for later rewrites.
 */
export async function readBoxWithSync(
	bytes: Uint8Array,
	password?: string,
	group?: GroupReadOptions,
	dataKey?: Uint8Array,
	externalResolver?: ExternalKeyResolver
): Promise<{
	snapshot: Snapshot;
	sidecar: unknown;
	author?: string;
	envelope?: BoxEnvelope;
	format: number;
}> {
	const entries = await unzip(bytes);
	const meta = metaOf(entries);
	const format = meta.format ?? BOX_FORMAT_PLAIN;
	if (
		format !== BOX_FORMAT_PLAIN &&
		format !== BOX_FORMAT_GROUP &&
		format !== BOX_FORMAT_ENVELOPE_AUTH
	) {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Backup format ${format} is not supported by this reader.`
		);
	}
	// Bind security mode to format generation both ways, so neither `keying`
	// nor `format` can be stripped to route a box down the wrong path.
	if ((format === BOX_FORMAT_GROUP) !== !!meta.keying) {
		throw new SelfstoreError(
			'BAD_FORMAT',
			'Group mode (format 2) and the keying field must agree.'
		);
	}
	if ((format === BOX_FORMAT_ENVELOPE_AUTH) !== Array.isArray(meta.keys)) {
		throw new SelfstoreError(
			'BAD_FORMAT',
			'Password envelope (format 3) and the keys field must agree.'
		);
	}
	if (meta.keying) return { ...(await readGroupBox(entries, meta, group)), format };
	if (format === BOX_FORMAT_ENVELOPE_AUTH) {
		return {
			...(await readEnvelopeBox(entries, meta, password, dataKey, externalResolver)),
			format
		};
	}
	if (meta.encryption === 'none') {
		return { snapshot: entriesToSnapshot(entries), sidecar: readSidecar(entries), format };
	}
	// Encrypted content in a container claiming the plain format: never written
	// by this library. Refuse cleanly rather than half-read.
	throw new SelfstoreError('BAD_FORMAT', 'Encrypted content in a plain-format container.');
}

// Envelope read path: bounds first, the held data key as a KDF-free fast
// path, then one trial per slot. All slots failing is DECRYPT_FAILED - wrong
// key and tampering stay one case.
async function readEnvelopeBox(
	entries: Record<string, Uint8Array>,
	meta: Header,
	password?: string,
	dataKey?: Uint8Array,
	externalResolver?: ExternalKeyResolver
): Promise<{ snapshot: Snapshot; sidecar: unknown; envelope: BoxEnvelope }> {
	const dataEnc = entries[DATA];
	const metaBytes = entries[META];
	const slots = meta.keys;
	if (
		!dataEnc ||
		!metaBytes ||
		!Array.isArray(slots) ||
		slots.length === 0 ||
		typeof meta.iv !== 'string' ||
		meta.encryption !== 'aes-256-gcm'
	) {
		throw new SelfstoreError('BAD_FORMAT', 'Missing or malformed envelope entries or parameters.');
	}
	if (slots.length > MAX_KEY_SLOTS) {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Backup declares ${slots.length} key slots; this reader caps at ${MAX_KEY_SLOTS} ` +
				'(each password slot is one memory-hard trial).'
		);
	}
	// The exact meta.json bytes are bound as GCM AAD: a tampered header (an
	// altered slot table, a swapped KDF) fails the decrypt instead of opening.
	const aad = metaBytes;
	const iv = fromBase64(meta.iv);
	// A caller re-reading its own file skips the KDF entirely. On failure fall
	// through to the slot trials - another device may have rotated the key.
	if (dataKey) {
		try {
			const r = await unpackWithSidecar(await gcmOpenAad(dataKey, iv, dataEnc, aad));
			return { ...r, envelope: { dataKey, slots } };
		} catch {
			/* rotated, foreign, or tampered file: the slot path decides */
		}
	}
	if (!password && !externalResolver) {
		throw new SelfstoreError(
			'PASSWORD_REQUIRED',
			'This backup is encrypted. Provide the password, or the external key (e.g. a passkey), to open it.'
		);
	}
	for (const slot of slots) {
		let opened: Uint8Array | null = null;
		if ((slot as ExternalSlot).kind === 'external') {
			if (externalResolver) {
				const secret = await externalResolver(slot as ExternalSlot);
				if (secret) opened = await openExternalSlot(slot as ExternalSlot, secret);
			}
		} else if (password) {
			opened = await openSlot(slot as PasswordSlot, password);
		}
		if (!opened) continue;
		// Every slot wraps the same data key, so if the decrypt below fails
		// (header tamper surfaces here on format 3) trying another slot gains
		// nothing - let it throw.
		const r = await unpackWithSidecar(await gcmOpenAad(opened, iv, dataEnc, aad));
		return { ...r, envelope: { dataKey: opened, slots } };
	}
	throw new SelfstoreError(
		'DECRYPT_FAILED',
		'Wrong key (no slot opened), or the backup is corrupted.'
	);
}

// Group read path, in trust order: shape, membership, signature, then
// envelope + decrypt.
async function readGroupBox(
	entries: Record<string, Uint8Array>,
	meta: Header,
	group?: GroupReadOptions
): Promise<{ snapshot: Snapshot; sidecar: unknown; author: string }> {
	if (!group || !Array.isArray(group.authors)) {
		throw new SelfstoreError(
			'IDENTITY_REQUIRED',
			'This copy is group-encrypted (per-member keys, no password). Open it with the member ' +
				'identity AND the trusted author list: the store does this when attached with { group }.'
		);
	}
	const metaBytes = entries[META];
	const dataEnc = entries[DATA];
	const sig = entries[SIG];
	// Trusted fields must be well-typed, not merely truthy: malformed input
	// fails closed as BAD_FORMAT, never reaches the crypto as a TypeError.
	if (
		!metaBytes ||
		!dataEnc ||
		!sig ||
		meta.format !== BOX_FORMAT_GROUP ||
		typeof meta.author !== 'string' ||
		meta.author.length === 0 ||
		!Array.isArray(meta.recipients) ||
		meta.recipients.length === 0 ||
		typeof meta.iv !== 'string'
	) {
		throw new SelfstoreError(
			'BAD_FORMAT',
			'Missing or malformed group encryption entries or parameters.'
		);
	}
	// Membership before any crypto: a valid signature over an attacker-chosen
	// author proves nothing.
	if (!group.authors.includes(meta.author)) {
		throw new SelfstoreError(
			'SIGNATURE_INVALID',
			'Copy author is not a trusted group member (check the membership manifest).'
		);
	}
	if (!(await verifyBox(metaBytes, dataEnc, sig, meta.author))) {
		throw new SelfstoreError('SIGNATURE_INVALID', 'Copy signature verification failed.');
	}
	const dataKey = await openDataKey(meta.recipients, group.identity);
	const inner = await gcmOpenRaw(dataKey, meta.iv, dataEnc);
	const r = await unpackWithSidecar(inner);
	return { ...r, author: meta.author };
}

/** Read a backup into a snapshot, ignoring the sync sidecar. */
export async function readBox(bytes: Uint8Array, password?: string): Promise<Snapshot> {
	return (await readBoxWithSync(bytes, password)).snapshot;
}

function metaOf(entries: Record<string, Uint8Array>): Header {
	const metaBytes = entries[META];
	if (!metaBytes) throw new SelfstoreError('BAD_FORMAT', 'Missing backup metadata.');
	const meta = JSON.parse(utf8.dec.decode(metaBytes)) as Header;
	if ((meta.format ?? BOX_FORMAT_PLAIN) > BOX_FORMAT_ENVELOPE_AUTH) {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Backup format v${meta.format} is newer than this reader supports.`
		);
	}
	assertKnownCrypto(meta);
	return meta;
}
