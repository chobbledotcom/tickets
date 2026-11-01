/**
 * The identity keys that maps and lookups go by. Neither function touches the
 * database, the clock, or the network, so a pure module can key its data with
 * them.
 */

/**
 * The key two spellings of one name or code compare by: surrounding spaces and
 * letter case dropped. A catalog name and a promo code both use it, so a lookup
 * never sees "Summer25" and " summer25" as two things.
 */
export const matchKey = (text: string): string => text.trim().toLowerCase();

/** Two ids as one map key, in the order given: a parent and its child, or a
 * person and a listing. */
export const pairKey = (first: number, second: number): string =>
  `${first}:${second}`;
