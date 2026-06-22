/** Pure helpers for account identity. */

import type { AccountRef } from "./types.ts";

/**
 * Separator used to build a canonical map key from an account's (type, id).
 * NUL cannot appear in a sane type/id, and `validateTransfer` rejects it, so the
 * key is unambiguous: `("a", "b c")` and `("a b", "c")` never collide (a plain
 * space would).
 */
export const ACCOUNT_KEY_SEPARATOR = "\u0000";

/** A stable, collision-free key for use as a Map key / for dedupe / grouping. */
export const accountKey = (a: AccountRef): string =>
  `${a.type}${ACCOUNT_KEY_SEPARATOR}${a.id}`;

/** Structural equality of two account references. */
export const sameAccount = (a: AccountRef, b: AccountRef): boolean =>
  a.type === b.type && a.id === b.id;

/** Build an account reference, stringifying a numeric row id. */
export const account = (type: string, id: number | string): AccountRef => ({
  id: String(id),
  type,
});
