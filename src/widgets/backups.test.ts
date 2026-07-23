// @vitest-environment happy-dom
/**
 * <selfstore-backups>: the panel skin over BackupsManager. The manager's
 * rules are proven in backups/manager.test.ts; here we prove the rendering
 * contract - rows with parts and pills, the active row inert and badged,
 * gestures wired to the manager, destructive gestures behind confirmAction,
 * the shared section (member + registry rows), the feature switches, labels.
 */

import { describe, it, expect, vi } from 'vitest';
import type { BackupRow, BackupsManager, BackupsSnapshot } from '../backups/manager';
import type { ReplicaFlow, ReplicaSnapshot } from '../flows/replica';
import { defineSelfstoreWidgets, SelfstoreBackupsElement } from '../entries/widgets';

defineSelfstoreWidgets();

const row = (fileId: string, label: string | null, extra: Partial<BackupRow> = {}): BackupRow => ({
	fileId,
	name: label ? `App (${label}).zip` : 'App.zip',
	label,
	modifiedAt: null,
	encrypted: false,
	shared: false,
	...extra
});

function fakeManager(initial: {
	rows?: BackupRow[];
	activeFileId?: string | null;
	joined?: boolean;
	shared?: { fileId: string; ownerEmail: string | null; ownerName: string | null }[];
}) {
	let snapshot: BackupsSnapshot = {
		registry: { personalFileId: 'p1', shared: initial.shared ?? [] },
		activeFileId: initial.activeFileId ?? null,
		joined: initial.joined ?? false,
		owner: null,
		lastError: null
	};
	const listeners = new Set<(s: BackupsSnapshot) => void>();
	let rows = initial.rows ?? [];
	const calls: Record<string, unknown[][]> = {};
	const log = (name: string, ...args: unknown[]): void => {
		(calls[name] ??= []).push(args);
	};
	const manager = {
		get snapshot() {
			return snapshot;
		},
		subscribe(fn: (s: BackupsSnapshot) => void) {
			listeners.add(fn);
			fn(snapshot);
			return () => listeners.delete(fn);
		},
		async hydrate() {
			log('hydrate');
		},
		async refresh() {
			log('refresh');
		},
		async markActive(fileId: string) {
			log('markActive', fileId);
		},
		async list() {
			log('list');
			return [...rows];
		},
		async probeEncryption(fileId: string) {
			log('probeEncryption', fileId);
			return null;
		},
		async noteShared() {},
		async openBackup(fileId: string, passphrase?: string | null) {
			log('openBackup', fileId, passphrase);
			const r = rows.find((x) => x.fileId === fileId);
			if (r?.encrypted && !passphrase) return 'encrypted' as const;
			snapshot = { ...snapshot, activeFileId: fileId };
			listeners.forEach((fn) => fn(snapshot));
			return 'ok' as const;
		},
		async openPersonal() {
			log('openPersonal');
			return 'ok' as const;
		},
		async createNamed(label: string) {
			log('createNamed', label);
			rows = [...rows, row(`f${rows.length + 1}`, label)];
			return 'ok' as const;
		},
		async renameBackup(fileId: string, label: string) {
			log('renameBackup', fileId, label);
			return 'ok' as const;
		},
		async deleteBackup(fileId: string) {
			log('deleteBackup', fileId);
			rows = rows.filter((x) => x.fileId !== fileId);
			return true;
		},
		async forgetShared(fileId: string) {
			log('forgetShared', fileId);
			snapshot = {
				...snapshot,
				registry: {
					...snapshot.registry,
					shared: snapshot.registry.shared.filter((s) => s.fileId !== fileId)
				}
			};
			listeners.forEach((fn) => fn(snapshot));
		},
		async registerShared(fileId: string, owner: { email: string | null; name: string | null }) {
			log('registerShared', fileId, owner);
		},
		async createShared(fileName: string) {
			log('createShared', fileName);
			return 'ok' as const;
		},
		fileNameFor(label: string) {
			return `App (${label.trim()}).zip`;
		}
	} satisfies BackupsManager;
	return { manager, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount(fake: ReturnType<typeof fakeManager>): Promise<SelfstoreBackupsElement> {
	const el = document.createElement('selfstore-backups') as SelfstoreBackupsElement;
	document.body.append(el);
	el.manager = fake.manager;
	await tick();
	await tick();
	return el;
}

const q = (el: SelfstoreBackupsElement, sel: string) => el.shadowRoot!.querySelector(sel);
const qa = (el: SelfstoreBackupsElement, sel: string) => [...el.shadowRoot!.querySelectorAll(sel)];

describe('selfstore-backups', () => {
	it('lists the rows, badges the active one and keeps it inert', async () => {
		const fake = fakeManager({
			rows: [row('p1', null), row('f2', 'family')],
			activeFileId: 'p1'
		});
		const el = await mount(fake);
		expect(qa(el, '[data-row]').length).toBe(2);
		const active = q(el, '[data-row="p1"]')!;
		expect(active.getAttribute('part')).toContain('card-active');
		expect(active.querySelector('[part~="tag"]')!.textContent).toBe('Active');
		expect(active.querySelector('[data-action="open"]')).toBeNull();
		expect(q(el, '[data-row="f2"] [data-action="open"]')).not.toBeNull();
	});

	it('renders the state pills and omits the unknown ones', async () => {
		const fake = fakeManager({
			rows: [
				row('p1', null, { encrypted: true, shared: null }),
				row('f2', 'family', { encrypted: null, shared: true })
			],
			activeFileId: null
		});
		const el = await mount(fake);
		expect(q(el, '[data-row="p1"] [part~="pill-encrypted"]')).not.toBeNull();
		expect(q(el, '[data-row="p1"] [part~="pill-shared"]')).toBeNull();
		expect(q(el, '[data-row="p1"] [part~="pill-private"]')).toBeNull();
		expect(q(el, '[data-row="f2"] [part~="pill-shared"]')).not.toBeNull();
		expect(q(el, '[data-row="f2"] [part~="pill-encrypted"]')).toBeNull();
	});

	it('prefers the live active states over the learned memories', async () => {
		const fake = fakeManager({
			rows: [row('p1', null, { encrypted: false, shared: false })],
			activeFileId: 'p1'
		});
		const el = await mount(fake);
		el.activeEncrypted = true;
		el.activeShared = true;
		expect(q(el, '[data-row="p1"] [part~="pill-encrypted"]')).not.toBeNull();
		expect(q(el, '[data-row="p1"] [part~="pill-shared"]')).not.toBeNull();
	});

	it('opens another row through the manager and emits', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		const opened = vi.fn();
		el.addEventListener('selfstore-backups-opened', opened);
		(q(el, '[data-row="f2"] [data-action="open"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.openBackup?.[0]).toEqual(['f2', null]);
		expect(opened).toHaveBeenCalledOnce();
	});

	it('collects the passphrase inline for a protected row, then opens with it', async () => {
		const fake = fakeManager({
			rows: [row('p1', null), row('f2', 'family', { encrypted: true })],
			activeFileId: 'p1'
		});
		const el = await mount(fake);
		(q(el, '[data-row="f2"] [data-action="open"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		const input = q(el, '[data-password="f2"] input') as HTMLInputElement;
		expect(input).not.toBeNull();
		input.value = 'secret';
		input.dispatchEvent(new Event('input'));
		(q(el, '[data-action="pw-open"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.openBackup?.[1]).toEqual(['f2', 'secret']);
		expect(q(el, '[data-password="f2"]')).toBeNull();
	});

	it('creates a named backup from the form and emits', async () => {
		const fake = fakeManager({ rows: [row('p1', null)], activeFileId: 'p1' });
		const el = await mount(fake);
		const created = vi.fn();
		el.addEventListener('selfstore-backups-created', created);
		(q(el, '[data-action="new"]') as HTMLButtonElement).click();
		const input = q(el, '[data-create] input') as HTMLInputElement;
		input.value = 'family';
		input.dispatchEvent(new Event('input'));
		(q(el, '[data-action="create"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.createNamed?.[0]).toEqual(['family']);
		expect(created).toHaveBeenCalledOnce();
	});

	it('refuses a name already taken', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		(q(el, '[data-action="new"]') as HTMLButtonElement).click();
		const input = q(el, '[data-create] input') as HTMLInputElement;
		input.value = 'Family';
		input.dispatchEvent(new Event('input'));
		expect(q(el, '[data-create] [part~="error-note"]')).not.toBeNull();
		expect((q(el, '[data-action="create"]') as HTMLButtonElement).disabled).toBe(true);
	});

	it('renames through the menu and the manager', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="rename"]') as HTMLButtonElement).click();
		const input = q(el, '[data-rename="f2"] input') as HTMLInputElement;
		input.value = 'holidays';
		input.dispatchEvent(new Event('input'));
		(q(el, '[data-action="rename-save"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.renameBackup?.[0]).toEqual(['f2', 'holidays']);
	});

	it('deletes only on a confirmed action, and not on a veto', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		const seen: unknown[] = [];
		el.confirmAction = (a) => {
			seen.push(a);
			return false;
		};
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="delete"]') as HTMLButtonElement).click();
		await tick();
		expect(seen).toEqual([
			{ type: 'delete', fileId: 'f2', name: 'App (family).zip', active: false }
		]);
		expect(fake.calls.deleteBackup).toBeUndefined();
		el.confirmAction = () => true;
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="delete"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.deleteBackup?.[0]).toEqual(['f2']);
	});

	it('emits encrypt/share with the row instead of acting', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		const enc = vi.fn();
		el.addEventListener('selfstore-backups-encrypt', enc as EventListener);
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="encrypt"]') as HTMLButtonElement).click();
		expect((enc.mock.calls[0][0] as CustomEvent).detail).toEqual({
			fileId: 'f2',
			label: 'family',
			active: false
		});
	});

	it('renders the shared section: member row leaves, registry row forgets', async () => {
		const fake = fakeManager({
			rows: [row('p1', null)],
			activeFileId: 'p1',
			shared: [{ fileId: 'x9', ownerEmail: 'ana@example.com', ownerName: null }]
		});
		const el = await mount(fake);
		el.member = { by: 'bob@example.com' };
		el.confirmAction = () => true;
		const leave = vi.fn();
		el.addEventListener('selfstore-backups-leave', leave);
		expect(q(el, '[data-member]')!.textContent).toContain('bob@example.com');
		expect(q(el, '[data-shared="x9"]')!.textContent).toContain('ana@example.com');
		(q(el, '[data-member] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="leave"]') as HTMLButtonElement).click();
		await tick();
		expect(leave).toHaveBeenCalledOnce();
		(q(el, '[data-shared="x9"] [data-action="menu"]') as HTMLButtonElement).click();
		(q(el, '[data-action="forget"]') as HTMLButtonElement).click();
		await tick();
		await tick();
		expect(fake.calls.forgetShared?.[0]).toEqual(['x9']);
		expect(q(el, '[data-shared="x9"]')).toBeNull();
	});

	it('never doubles an owner: a stray registry entry for a membership owner is dropped', async () => {
		// The joined silo w1 (ana) sits in the registry AND is a membership;
		// a leftover registry file x9 from the SAME owner (a re-join left it
		// behind) must not add a second Forget-only "Shared by ana" row.
		const fake = fakeManager({
			rows: [row('p1', null)],
			activeFileId: 'p1',
			shared: [
				{ fileId: 'x9', ownerEmail: 'ana@example.com', ownerName: null },
				{ fileId: 'w1', ownerEmail: 'ana@example.com', ownerName: null }
			]
		});
		const el = await mount(fake);
		el.member = [{ by: 'ana@example.com', fileId: 'w1' }];
		el.confirmAction = () => true;
		// One row for ana - the membership one, openable and leaving.
		expect(q(el, '[data-shared="w1"]')).not.toBeNull();
		expect(q(el, '[data-shared="x9"]')).toBeNull();
		(q(el, '[data-shared="w1"] [data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[data-action="leave"]')).not.toBeNull();
		expect(q(el, '[data-action="forget"]')).toBeNull();
	});

	it('a wallet-bound membership: badge row while its silo is attached, openable registry row otherwise', async () => {
		// The joined wallet is in the shared registry (it presents as the
		// sharer's), and the membership names its fileId.
		const fake = fakeManager({
			rows: [row('p1', null)],
			activeFileId: 'w1',
			joined: true,
			shared: [{ fileId: 'w1', ownerEmail: 'ana@example.com', ownerName: null }]
		});
		const el = await mount(fake);
		el.member = { by: 'ana@example.com', fileId: 'w1' };
		el.confirmAction = () => true;
		// Attached: the badge row owns it (no duplicate registry row).
		expect(q(el, '[data-member]')!.textContent).toContain('ana@example.com');
		expect(q(el, '[data-member] [part~="tag"]')!.textContent).toBe('Active');
		expect(q(el, '[data-shared="w1"]')).toBeNull();
		(q(el, '[data-member] [data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[data-action="leave"]')).not.toBeNull();
		(q(el, '[part~="menu-backdrop"]') as HTMLElement).click();

		// Another silo attached: the registry row stands in - openable, and its
		// one action is leaving, never a mere forget.
		const leave = vi.fn();
		el.addEventListener('selfstore-backups-leave', leave);
		await fake.manager.openBackup('p1');
		await tick();
		expect(q(el, '[data-member]')).toBeNull();
		const walletRow = q(el, '[data-shared="w1"]')!;
		expect(walletRow.querySelector('[data-action="open-shared"]')).not.toBeNull();
		(walletRow.querySelector('[data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[data-action="forget"]')).toBeNull();
		(q(el, '[data-action="leave"]') as HTMLButtonElement).click();
		await tick();
		expect(leave).toHaveBeenCalledOnce();
	});

	it('several memberships: badge on the attached silo, Leave on every joined row, detail names the file', async () => {
		const fake = fakeManager({
			rows: [row('p1', null)],
			activeFileId: 'w1',
			joined: true,
			shared: [
				{ fileId: 'w1', ownerEmail: 'ana@example.com', ownerName: null },
				{ fileId: 'w2', ownerEmail: 'marc@example.com', ownerName: null }
			]
		});
		const el = await mount(fake);
		el.member = [
			{ by: 'ana@example.com', fileId: 'w1' },
			{ by: 'marc@example.com', fileId: 'w2' }
		];
		el.confirmAction = () => true;
		const leave = vi.fn();
		el.addEventListener('selfstore-backups-leave', leave);
		// The attached silo wears the badge; the other joined silo is a normal
		// openable row whose one action is leaving THAT share.
		expect(q(el, '[data-member]')!.textContent).toContain('ana@example.com');
		expect(q(el, '[data-shared="w1"]')).toBeNull();
		const marcRow = q(el, '[data-shared="w2"]')!;
		expect(marcRow.querySelector('[data-action="open-shared"]')).not.toBeNull();
		(marcRow.querySelector('[data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[data-action="forget"]')).toBeNull();
		(q(el, '[data-action="leave"]') as HTMLButtonElement).click();
		await tick();
		expect(leave).toHaveBeenCalledOnce();
		expect((leave.mock.calls[0][0] as CustomEvent).detail).toEqual({ fileId: 'w2' });
	});

	it('honors the feature switches', async () => {
		const fake = fakeManager({
			rows: [row('p1', null), row('f2', 'family')],
			activeFileId: 'p1',
			shared: [{ fileId: 'x9', ownerEmail: 'ana@example.com', ownerName: null }]
		});
		const el = await mount(fake);
		el.setAttribute('with-create', 'off');
		el.setAttribute('with-shared', 'off');
		el.setAttribute('with-rename', 'off');
		expect(q(el, '[data-action="new"]')).toBeNull();
		expect(q(el, '[data-shared="x9"]')).toBeNull();
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[data-action="rename"]')).toBeNull();
		expect(q(el, '[data-action="delete"]')).not.toBeNull();
	});

	it('the overflow menu closes on an outside click and on Escape', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		expect(q(el, '[part~="menu"]')).not.toBeNull();
		// Anywhere outside lands on the backdrop: the menu dismisses.
		(q(el, '[part~="menu-backdrop"]') as HTMLElement).click();
		expect(q(el, '[part~="menu"]')).toBeNull();
		// Escape closes too, and focus returns to the trigger.
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		q(el, '[part~="menu"]')!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
		);
		expect(q(el, '[part~="menu"]')).toBeNull();
		expect(el.shadowRoot!.activeElement?.getAttribute('data-menu-key')).toBe('f2');
	});

	it('speaks the host language through labels', async () => {
		const fake = fakeManager({ rows: [row('p1', null)], activeFileId: 'p1' });
		const el = await mount(fake);
		el.labels = { 'backups.mine.heading': 'Mes sauvegardes', 'backups.mine.personal': 'Personal' };
		expect(qa(el, '[part~="heading"]')[0].textContent).toBe('Mes sauvegardes');
		expect(q(el, '[data-row="p1"] [part~="title"]')!.textContent).toContain('Personal');
	});
});

// --- Backup copy (replica) ---------------------------------------------------

function fakeReplicaFlow(initial: Partial<ReplicaSnapshot> = {}) {
	let snapshot: ReplicaSnapshot = {
		step: 'idle',
		kinds: ['drive', 'file'],
		busy: false,
		error: null,
		replica: null,
		...initial
	};
	const listeners = new Set<(s: ReplicaSnapshot) => void>();
	const set = (patch: Partial<ReplicaSnapshot>): void => {
		snapshot = { ...snapshot, ...patch };
		listeners.forEach((fn) => fn(snapshot));
	};
	const calls: Record<string, unknown[][]> = {};
	const log = (name: string, ...args: unknown[]): void => {
		(calls[name] ??= []).push(args);
	};
	const flow: ReplicaFlow = {
		get snapshot() {
			return snapshot;
		},
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot);
			return () => listeners.delete(fn);
		},
		open() {
			log('open');
			set({ step: 'choose' });
		},
		cancel() {
			log('cancel');
			set({ step: 'idle' });
		},
		pick(kind) {
			log('pick', kind);
		},
		submitWebdav(config) {
			log('submitWebdav', config);
		},
		submitS3(config) {
			log('submitS3', config);
		},
		async remove() {
			log('remove');
			set({ replica: null });
		},
		async restore() {
			log('restore');
		},
		dispose() {
			log('dispose');
		}
	};
	return { flow, set, calls };
}

describe('selfstore-backups: backup copy (replica)', () => {
	it('renders NOTHING without a flow - the panel is unchanged', async () => {
		const fake = fakeManager({ rows: [row('p1', null)], activeFileId: 'p1' });
		const el = await mount(fake);
		expect(q(el, '[data-replica]')).toBeNull();
		(q(el, '[data-row="p1"] [data-action="menu"]') as HTMLButtonElement).click();
		await tick();
		expect(q(el, '[data-action="replica-add"]')).toBeNull();
	});

	it('with a flow: an entry in the ACTIVE card menu opens the choice', async () => {
		const fake = fakeManager({ rows: [row('p1', null), row('f2', 'family')], activeFileId: 'p1' });
		const el = await mount(fake);
		const { flow, calls } = fakeReplicaFlow();
		el.replica = flow;
		await tick();

		expect(calls.restore?.length).toBe(1); // the widget restores by itself
		// Idle adds nothing to the panel.
		expect(q(el, '[data-replica]')).toBeNull();
		expect(q(el, '[part~="replica-picker"]')).toBeNull();
		// Only the active card's menu offers the entry.
		(q(el, '[data-row="f2"] [data-action="menu"]') as HTMLButtonElement).click();
		await tick();
		expect(q(el, '[data-action="replica-add"]')).toBeNull();
		(q(el, '[data-row="p1"] [data-action="menu"]') as HTMLButtonElement).click();
		await tick();
		(q(el, '[data-action="replica-add"]') as HTMLButtonElement).click();
		await tick();
		expect(calls.open?.length).toBe(1);
		// The choice card sits right under the active card.
		const picker = q(el, '[part~="replica-picker"]')!;
		expect(picker).not.toBeNull();
		expect(picker.previousElementSibling?.getAttribute('data-row')).toBe('p1');
		(picker.querySelector('[data-kind="drive"]') as HTMLButtonElement).click();
		expect(calls.pick?.[0]).toEqual(['drive']);
	});

	it('an attached copy renders one line and Remove routes through confirmAction', async () => {
		const fake = fakeManager({ rows: [row('p1', null)], activeFileId: 'p1' });
		const el = await mount(fake);
		const seen: unknown[] = [];
		el.confirmAction = (a) => {
			seen.push(a);
			return true;
		};
		const { flow, set, calls } = fakeReplicaFlow();
		el.replica = flow;
		set({
			replica: { id: 'replica', label: 'Drive', lastPublishAt: 1700000000000, lastError: null }
		});
		await tick();

		// The copy is ONE line INSIDE the active card, not a card/block of its own.
		const line = q(el, '[data-replica]')!;
		expect(line).not.toBeNull();
		expect(line.getAttribute('part')).not.toContain('card');
		expect(line.closest('[data-row]')?.getAttribute('data-row')).toBe('p1');
		expect(line.querySelector('[part~="replica-label"]')!.textContent).toContain('Drive');
		expect(line.querySelector('[part~="replica-ok"]')).not.toBeNull();
		// Once attached, the active card's menu drops the add entry.
		(q(el, '[data-row="p1"] [data-action="menu"]') as HTMLButtonElement).click();
		await tick();
		expect(q(el, '[data-action="replica-add"]')).toBeNull();
		// Remove is an inline link on the line, no menu.
		(q(el, '[data-replica] [data-action="replica-remove"]') as HTMLButtonElement).click();
		await tick();
		expect(seen).toEqual([{ type: 'replica-remove', label: 'Drive' }]);
		expect(calls.remove?.length).toBe(1);
	});

	it('a broken copy shows the retry note, never a blocking state', async () => {
		const fake = fakeManager({ rows: [row('p1', null)], activeFileId: 'p1' });
		const el = await mount(fake);
		const { flow, set } = fakeReplicaFlow();
		el.replica = flow;
		set({
			replica: {
				id: 'replica',
				label: 'Drive',
				lastPublishAt: null,
				lastError: { code: 'TARGET_UNAVAILABLE', labelKey: 'error.targetUnavailable', message: 'x' }
			}
		});
		await tick();
		expect(q(el, '[part~="replica-error"]')).not.toBeNull();
		// The rest of the panel stays fully usable.
		expect(q(el, '[data-action="new"]')).not.toBeNull();
	});
});
