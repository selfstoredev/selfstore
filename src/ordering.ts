/*
 * ORDERING THAT MUST NOT DEPEND ON WHO IS READING.
 *
 * Two places in this library sort strings, and in both the requirement is the
 * same: the order has to be a property of the strings, not of the machine.
 *
 *   - `sigv4` builds a canonical request whose header names are sorted BY CODE
 *     POINT. That is what the signature is defined over, so any other order
 *     produces one the service rejects.
 *   - `stableStringify` orders the keys that feed a hash which has to come out
 *     identical on every device holding the record.
 *
 * A bare `.sort()` already does exactly this, and static analysis is right to
 * flag it anyway: the advice attached to that warning is "compare with
 * `localeCompare`", and taking it would break both. A locale-aware comparison
 * orders the same two strings differently under a different locale - so a
 * Turkish device and a French one would hash one unchanged record two ways,
 * and each would read the other as an edit. In a sync library that is silent
 * data loss, not a lint warning.
 *
 * So it is spelt out here, once, with the reason attached - and nobody has to
 * rediscover it in front of a red analyser.
 */

/** Order two strings by code point. Byte for byte what a bare `.sort()` does,
 *  and unlike it, deliberate. */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
