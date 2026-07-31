// @vitest-environment happy-dom
/**
 * <selfstore-destination>: the panel over a store that HAS a home. Prove it
 * names the destination and its account, runs the gestures the engine owns
 * (export, detach) rather than asking the host, honours the veto, asks the host
 * only for the one it structurally cannot do (loading a copy back), and offers
 * no change button when there is nothing to change to.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FlowHost } from '../flows/connect';
import type { LocalStore } from '../persistence/store';
import { defineSelfstoreWidgets, SelfstoreDestinationElement } from '../entries/widgets';

defineSelfstoreWidgets();

/** An engine stub: the state the panel reads, plus the operations it runs. */
function fakeEngine(overrides: Partial<LocalStore['state']> = {}) {
	const subs = new Set<() => void>();
	const calls = { exported: 0, detached: 0, marked: 0 };
	const state = {
		targetKind: 'drive',
		label: 'app.zip',
		encrypted: false,
		status: {
			state: 'saved',
			severity: 'ok',
			actionable: false,
			labelKey: 'status.saved'
		},
		...overrides
	};
	const engine = {
		state,
		calls,
		subscribe(fn: () => void) {
			subs.add(fn);
			return () => subs.delete(fn);
		},
		async exportBlob() {
			calls.exported++;
			return new Blob(['x']);
		},
		markDownloaded() {
			calls.marked++;
		},
		async detachTarget() {
			calls.detached++;
			Object.assign(state, { targetKind: 'device', label: null });
			for (const fn of subs) fn();
		}
	} as unknown as LocalStore & { calls: typeof calls };
	return engine;
}

function mount(engine: LocalStore): SelfstoreDestinationElement {
	const el = document.createElement('selfstore-destination') as SelfstoreDestinationElement;
	document.body.append(el);
	const host: FlowHost = { engine, kv: {} as FlowHost['kv'], backupName: 'app.zip' };
	el.store = host;
	return el;
}

const text = (el: HTMLElement): string => el.shadowRoot!.textContent!.replace(/\s+/g, ' ');
const buttons = (el: HTMLElement): HTMLButtonElement[] => [
	...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')
];
const byText = (el: HTMLElement, needle: string): HTMLButtonElement | undefined =>
	buttons(el).find((b) => (b.textContent ?? '').includes(needle));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('selfstore-destination', () => {
	it('names the destination, the account holding it, and its protection', () => {
		const el = mount(fakeEngine({ encrypted: true }));
		el.account = 'someone@example.com';

		const shown = text(el);
		expect(shown).toContain('Google Drive');
		expect(shown).toContain('someone@example.com');
		expect(shown).toContain('Password-protected');
		// The state line is the status widget's, not a second vocabulary.
		expect(el.shadowRoot!.querySelector('selfstore-status')).not.toBeNull();
	});

	it('falls back to a host target own label instead of printing a raw key', () => {
		const el = mount(fakeEngine({ targetKind: 'my-nas', label: 'Basement NAS' }));

		expect(text(el)).toContain('Basement NAS');
		expect(text(el)).not.toContain('destination.kind.my-nas');
	});

	it('exports a copy itself, through the engine, and clears the export nudge', async () => {
		const engine = fakeEngine();
		const calls = (engine as unknown as { calls: { exported: number; marked: number } }).calls;
		const el = mount(engine);
		const written: Blob[] = [];
		vi.stubGlobal('showSaveFilePicker', async () => ({
			createWritable: async () => ({
				write: async (b: Blob) => void written.push(b),
				close: async () => {}
			})
		}));

		byText(el, 'Export a copy')!.click();
		await settle();
		await settle();

		// The engine's own export ran - the host was never asked for it.
		expect(calls.exported).toBe(1);
		expect(written).toHaveLength(1);
		expect(calls.marked).toBe(1);
		expect(text(el)).toContain('The copy is written');
	});

	it('a closed save dialog claims nothing and clears no nudge', async () => {
		const engine = fakeEngine();
		const calls = (engine as unknown as { calls: { marked: number } }).calls;
		const el = mount(engine);
		vi.stubGlobal('showSaveFilePicker', async () => {
			throw new DOMException('closed', 'AbortError');
		});

		byText(el, 'Export a copy')!.click();
		await settle();
		await settle();

		// The download that lies about itself: never again.
		expect(text(el)).toContain('Nothing was written');
		expect(calls.marked).toBe(0);
	});

	it('detaches itself, and the veto stops it', async () => {
		const engine = fakeEngine();
		const el = mount(engine);
		const calls = (engine as unknown as { calls: { detached: number } }).calls;

		el.confirmAction = () => false;
		byText(el, 'Stop saving here')!.click();
		await settle();
		expect(calls.detached).toBe(0); // refused, and nothing said it happened

		el.confirmAction = () => true;
		byText(el, 'Stop saving here')!.click();
		await settle();
		await settle();
		expect(calls.detached).toBe(1);
		// It says what stopped and what did NOT: the data stays.
		expect(text(el)).toContain('Your data stays on this device');
	});

	it('treats a throwing veto as a no, never as a yes', async () => {
		const engine = fakeEngine();
		const el = mount(engine);
		el.confirmAction = () => {
			throw new Error('undecided');
		};

		byText(el, 'Stop saving here')!.click();
		await settle();

		expect((engine as unknown as { calls: { detached: number } }).calls.detached).toBe(0);
	});

	it('asks the host for the one gesture the library cannot do: loading a copy back', async () => {
		const el = mount(fakeEngine());
		const seen: unknown[] = [];
		el.addEventListener('selfstore-destination-action', (e) =>
			seen.push((e as CustomEvent).detail)
		);

		byText(el, 'Restore a copy')!.click();
		await settle();

		// The library holds no records - the app's own apply does.
		expect(seen).toEqual([{ action: 'restore' }]);
	});

	it('an empty-string label removes a gesture, same convention as the headings', () => {
		const el = mount(fakeEngine());
		expect(byText(el, 'Stop saving here')).toBeDefined();

		// A host that forbids the device-only state takes the journey off the
		// screen; the other gestures are untouched.
		el.labels = { 'destination.detach': '' };

		expect(byText(el, 'Stop saving here')).toBeUndefined();
		expect(byText(el, 'Export a copy')).toBeDefined();
		expect(byText(el, 'Restore a copy')).toBeDefined();
	});

	it('each gesture carries its own part, so a host can prune ONE from CSS', () => {
		const el = mount(fakeEngine());

		const parts = buttons(el).map((b) => b.getAttribute('part') ?? '');
		expect(parts.some((p) => p.includes('destination-export'))).toBe(true);
		expect(parts.some((p) => p.includes('destination-restore'))).toBe(true);
		expect(parts.some((p) => p.includes('destination-detach'))).toBe(true);
	});

	it('offers no way to change backup when there is nothing to change to', () => {
		const el = mount(fakeEngine());
		expect(byText(el, 'Change backup')).toBeUndefined(); // absent, not dead

		el.targets = { file: true };
		expect(byText(el, 'Change backup')).toBeDefined();
	});

	it('changes backup by letting the destination go, not by connecting in place', async () => {
		// One journey for one decision. The panel used to run a second connect
		// inside itself, so changing backup worked one way from the page and
		// another from the header - and only the header's could be reached from
		// anywhere in the app. Detaching hands it to the first-run screen, which
		// is the same screen either way.
		const engine = fakeEngine();
		const el = mount(engine);
		el.targets = { file: true };

		byText(el, 'Change backup')!.click();
		await settle();

		expect(engine.calls.detached).toBe(1);
		expect(el.shadowRoot!.querySelector('selfstore-connect')).toBeNull();
	});

	it('names every mode the store can fall back to, raw keys reaching nobody', () => {
		// file-manual is a mode the STORE itself falls back to, on a browser that
		// cannot hold a writable file handle. Without a shipped name, the panel
		// showed the user the raw key - found the day a second app mounted this.
		const el = mount(fakeEngine({ targetKind: 'file-manual', label: null }));

		expect(text(el)).toContain('A file you download');
		expect(text(el)).not.toContain('destination.kind.');
	});

	it('speaks the page language without a single label from the host', () => {
		document.documentElement.lang = 'fr';
		const el = mount(fakeEngine());

		expect(text(el)).toContain('Où vos données sont enregistrées');
		expect(text(el)).toContain('Ne plus enregistrer ici');
		document.documentElement.lang = '';
	});
});
