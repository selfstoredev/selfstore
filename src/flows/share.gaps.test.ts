import { describe, it, expect } from 'vitest';
import { shareFlow, type ShareEngine, type ShareLinkInfo, type ShareMemberInfo } from './share';
import type { StoreError } from '../persistence/store';

const link = (id: string): ShareLinkInfo => ({ id, url: `https://x.test/j#${id}`, level: 'write' });
const member = (id: string, self = false): ShareMemberInfo => ({ id, self });

describe('shareFlow error handling', () => {
	it('removeMember sets error and returns false on engine rejection', async () => {
		const members: ShareMemberInfo[] = [member('m1', false), member('m2', true)];
		const engine: ShareEngine = {
			list: async () => ({ links: [], members }),
			createLink: async () => link('l1'),
			revokeLink: async () => undefined,
			removeMember: async () => {
				throw new Error('remove error');
			},
			revokeAll: async () => undefined
		};

		const flow = shareFlow(engine);
		await flow.refresh();
		expect(flow.snapshot.canRemoveMembers).toBe(true);

		const result = await flow.removeMember('m1');
		expect(result).toBe(false);
		expect(flow.snapshot.busy).toBeNull();
		expect(flow.snapshot.error).not.toBeNull();
		expect((flow.snapshot.error as StoreError).message).toBe('remove error');
		expect(flow.snapshot.members).toEqual(members);
		expect(flow.snapshot.links).toEqual([]);
	});

	it('revokeLink sets error and returns false on engine rejection', async () => {
		const engine: ShareEngine = {
			list: async () => ({ links: [], members: [] }),
			createLink: async () => link('l1'),
			revokeLink: async () => {
				throw new Error('revoke error');
			},
			removeMember: async () => undefined,
			revokeAll: async () => undefined
		};

		const flow = shareFlow(engine);
		await flow.refresh();
		const result = await flow.revokeLink('someId');
		expect(result).toBe(false);
		expect(flow.snapshot.busy).toBeNull();
		expect(flow.snapshot.error).not.toBeNull();
		expect((flow.snapshot.error as StoreError).message).toBe('revoke error');
	});
});
