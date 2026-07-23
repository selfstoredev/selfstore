// A password strength policy the store can enforce and a UI can preview from
// the same rules. Deliberately small: length plus character-class requirements,
// no dictionary or breach checks (those need data the library does not ship).
// Unicode-aware so an accented letter counts as a letter and an emoji counts as
// one character, not two.

export interface PasswordPolicy {
	/** Minimum length in code points (so an emoji counts as one). Default 0. */
	minLength?: number;
	/** Require at least one lowercase letter (any script with case). */
	requireLowercase?: boolean;
	/** Require at least one uppercase letter (any script with case). */
	requireUppercase?: boolean;
	/** Require at least one digit. */
	requireDigit?: boolean;
	/** Require at least one symbol: anything that is not a letter or a number. */
	requireSymbol?: boolean;
}

/** A stable code for each unmet requirement, so the app maps it to its own copy
 *  (like the error codes). `minLength` covers the length rule. */
export type PasswordRequirement = 'minLength' | 'lowercase' | 'uppercase' | 'digit' | 'symbol';

export interface PasswordCheck {
	ok: boolean;
	/** The requirements the password fails, in a stable order. Empty when ok. */
	unmet: PasswordRequirement[];
}

/** Measure a password against a policy. Pure and synchronous: the same call
 *  drives a live strength hint in the UI and the store's enforcement. An empty
 *  or absent policy passes everything. */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy): PasswordCheck {
	const unmet: PasswordRequirement[] = [];
	// Count code points, not UTF-16 units, so a password of emoji is not
	// over-counted and a min-length rule stays intuitive.
	if ([...password].length < (policy.minLength ?? 0)) unmet.push('minLength');
	if (policy.requireLowercase && !/\p{Ll}/u.test(password)) unmet.push('lowercase');
	if (policy.requireUppercase && !/\p{Lu}/u.test(password)) unmet.push('uppercase');
	if (policy.requireDigit && !/\p{Nd}/u.test(password)) unmet.push('digit');
	if (policy.requireSymbol && !/[^\p{L}\p{N}]/u.test(password)) unmet.push('symbol');
	return { ok: unmet.length === 0, unmet };
}
