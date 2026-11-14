import { describe, it, expect } from 'vitest';
import { publicIdentity, type GroupIdentity } from './group';

describe('publicIdentity', () => {
	it('returns sigPub and encPub from the identity', () => {
		const id: GroupIdentity = {
			sigPub: 'sigPubValue',
			sigPriv: 'sigPrivValue',
			encPub: 'encPubValue',
			encPriv: 'encPrivValue'
		};
		const result = publicIdentity(id);
		expect(result).toEqual({ sig: 'sigPubValue', enc: 'encPubValue' });
	});

	it('does not include private keys in the result', () => {
		const id: GroupIdentity = {
			sigPub: 'pub1',
			sigPriv: 'priv1',
			encPub: 'pub2',
			encPriv: 'priv2'
		};
		const result = publicIdentity(id);
		expect(result).not.toHaveProperty('sigPriv');
		expect(result).not.toHaveProperty('encPriv');
		expect(Object.keys(result)).toEqual(['sig', 'enc']);
	});
});
