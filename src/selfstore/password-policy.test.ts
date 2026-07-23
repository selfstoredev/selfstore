import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy } from './password-policy';

describe('checkPasswordPolicy', () => {
	it('passes everything under an empty policy', () => {
		expect(checkPasswordPolicy('', {})).toEqual({ ok: true, unmet: [] });
		expect(checkPasswordPolicy('x', {})).toEqual({ ok: true, unmet: [] });
	});

	it('measures length in code points, so an emoji counts as one', () => {
		expect(checkPasswordPolicy('ab', { minLength: 3 }).unmet).toEqual(['minLength']);
		expect(checkPasswordPolicy('abc', { minLength: 3 }).ok).toBe(true);
		// Three emoji are three characters, not six UTF-16 units.
		expect(checkPasswordPolicy('\u{1F600}\u{1F601}\u{1F602}', { minLength: 3 }).ok).toBe(true);
	});

	it('reports each unmet character class, in a stable order', () => {
		const check = checkPasswordPolicy('abc', {
			minLength: 8,
			requireUppercase: true,
			requireDigit: true,
			requireSymbol: true
		});
		expect(check.ok).toBe(false);
		expect(check.unmet).toEqual(['minLength', 'uppercase', 'digit', 'symbol']);
	});

	it('accepts a password that meets every class', () => {
		expect(
			checkPasswordPolicy('Abcdef1!', {
				minLength: 8,
				requireLowercase: true,
				requireUppercase: true,
				requireDigit: true,
				requireSymbol: true
			})
		).toEqual({ ok: true, unmet: [] });
	});

	it('is unicode-aware: accented letters count, a space is a symbol', () => {
		// 'é' is a lowercase letter; no ASCII fallback needed.
		expect(checkPasswordPolicy('éùo', { requireLowercase: true }).ok).toBe(true);
		expect(checkPasswordPolicy('ABC', { requireLowercase: true }).unmet).toEqual(['lowercase']);
		// A symbol is anything that is not a letter or a number.
		expect(checkPasswordPolicy('abc def', { requireSymbol: true }).ok).toBe(true);
		expect(checkPasswordPolicy('abcdef', { requireSymbol: true }).unmet).toEqual(['symbol']);
	});
});
