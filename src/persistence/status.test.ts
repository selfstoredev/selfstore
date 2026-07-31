import { describe, it, expect } from 'vitest';
import { deriveStatus, type StatusInput } from './status';

const base: StatusInput = {
	persistent: true,
	targetKind: 'drive',
	saving: false,
	needsAttention: false,
	locked: false,
	pendingDownload: false
};

describe('deriveStatus', () => {
	it('ephemeral wins over everything', () => {
		const s = deriveStatus({ ...base, persistent: false, saving: true, needsAttention: true });
		expect(s.state).toBe('ephemeral');
		expect(s.severity).toBe('warn');
		expect(s.action).toBe('choose-destination');
	});

	it('a broken durable home is reported as danger before "saving"', () => {
		const s = deriveStatus({ ...base, needsAttention: true, saving: true });
		expect(s.state).toBe('needs-attention');
		expect(s.severity).toBe('danger');
		expect(s.action).toBe('reconnect');
	});

	it('a locked target asks to unlock, not reconnect', () => {
		const s = deriveStatus({ ...base, needsAttention: true, locked: true });
		expect(s.state).toBe('needs-attention');
		expect(s.action).toBe('unlock'); // the app offers a password field, not a reauth
	});

	it('shows saving when a write is in flight', () => {
		expect(deriveStatus({ ...base, saving: true }).state).toBe('saving');
	});

	it('device-only is a warn nudge, not a comfortable ok', () => {
		const s = deriveStatus({ ...base, targetKind: 'device' });
		expect(s.state).toBe('cache-only');
		expect(s.severity).toBe('warn');
		expect(s.action).toBe('choose-destination');
	});

	it('degraded file mode surfaces a pending download, and warns', () => {
		// The severity drives the colour of a pill. As 'info' it rendered calm next
		// to a button asking for a gesture: the colour said all was well while the
		// button said otherwise. What has been typed since the last export exists
		// nowhere but this browser.
		const s = deriveStatus({ ...base, targetKind: 'file-manual', pendingDownload: true });
		expect(s.state).toBe('pending-download');
		expect(s.action).toBe('download');
		expect(s.severity).toBe('warn');
	});

	it('a connected, idle durable home is ok', () => {
		const s = deriveStatus(base);
		expect(s.state).toBe('saved');
		expect(s.severity).toBe('ok');
		expect(s.actionable).toBe(false);
	});

	it('file-manual without pending changes is ok', () => {
		expect(deriveStatus({ ...base, targetKind: 'file-manual' }).state).toBe('saved');
	});
});

describe('a copy is not nothing', () => {
	it('stops saying "never saved anywhere" to someone holding this morning copy', () => {
		// Announcing that to a user looking at the backup they exported an hour
		// ago is what costs an app its credibility - and every consumer that hit
		// it kept a memo of its own to work around it.
		const base = {
			persistent: true,
			targetKind: 'device',
			saving: false,
			needsAttention: false,
			locked: false,
			pendingDownload: false
		};

		expect(deriveStatus(base).labelKey).toBe('status.cacheOnly');

		const fresh = deriveStatus({ ...base, copy: { at: 1, stale: false } });
		expect(fresh.labelKey).toBe('status.copy');
		expect(fresh.severity).toBe('ok');
		// The gesture stays: no durable destination is attached, and that is
		// exactly what it is for.
		expect(fresh.action).toBe('choose-destination');
		expect(fresh.state).toBe('cache-only');

		const stale = deriveStatus({ ...base, copy: { at: 1, stale: true } });
		expect(stale.labelKey).toBe('status.copyStale');
		expect(stale.severity).toBe('warn');
	});
});
