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

	it('degraded file mode surfaces a pending download', () => {
		const s = deriveStatus({ ...base, targetKind: 'file-manual', pendingDownload: true });
		expect(s.state).toBe('pending-download');
		expect(s.action).toBe('download');
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
