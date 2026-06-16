/**
 * Short-lived, in-memory stash that carries submitted form values across a
 * POST → redirect → GET (Post/Redirect/Get) cycle without putting them in a
 * cookie or the URL.
 *
 * When a submission fails validation the handler redirects back to the form.
 * The values are stashed here under a high-entropy token that travels only
 * inside the existing HttpOnly, SameSite=Strict flash cookie. On the follow-up
 * GET — almost always the same warm edge isolate a few milliseconds later — the
 * token is redeemed, the values are handed to setSavedFormData(), and
 * renderFields() re-fills the inputs with no template or handler changes.
 *
 * This mirrors the settings cache: a warm-isolate optimisation with a graceful
 * cold fallback. A cold or different isolate simply misses, and the flash
 * cookie still carries the message (the existing behaviour), so the stash is
 * never a correctness dependency. Entries are one-shot (deleted on redeem),
 * expire after a few seconds, and are capped in both per-entry size and total
 * count to bound memory and limit abuse.
 */

import { registerCache } from "#shared/cache-registry.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import {
  FORM_STASH_MAX_BYTES,
  FORM_STASH_MAX_ENTRIES,
  FORM_STASH_TTL_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

type StashEntry = { data: string; expires: number };

/** Token → serialized form body. Module-global so it survives across requests
 * on a warm isolate (the whole point); it's discarded when the isolate
 * recycles, which the cookie-flash fallback covers. */
const store = new Map<string, StashEntry>();

registerCache(() => ({
  capacity: FORM_STASH_MAX_ENTRIES,
  entries: store.size,
  name: "form-stash",
}));

/**
 * Drop expired entries, then evict oldest-inserted survivors until there is
 * room for one more. A Map preserves insertion order, so iterating yields the
 * oldest first.
 */
const evict = (): void => {
  const now = nowMs();
  const survivors: string[] = [];
  for (const [token, entry] of store) {
    if (entry.expires <= now) store.delete(token);
    else survivors.push(token);
  }
  let removable = survivors.length - (FORM_STASH_MAX_ENTRIES - 1);
  for (const token of survivors) {
    if (removable <= 0) break;
    store.delete(token);
    removable--;
  }
};

/**
 * Stash a serialized form body and return its redemption token, or null when
 * the body is empty or larger than FORM_STASH_MAX_BYTES — in which case the
 * caller falls back to the cookie-only flash. The serialized body is
 * percent-encoded ASCII, so its character length equals its byte length.
 */
export const stashForm = (data: string): string | null => {
  if (!data || data.length > FORM_STASH_MAX_BYTES) return null;
  evict();
  const token = generateSecureToken();
  store.set(token, { data, expires: nowMs() + FORM_STASH_TTL_MS });
  return token;
};

/**
 * Redeem a token: return its stashed body exactly once, then delete it.
 * Returns null when the token is unknown or has expired.
 */
export const takeForm = (token: string): string | null => {
  const entry = store.get(token);
  if (!entry) return null;
  store.delete(token);
  return entry.expires <= nowMs() ? null : entry.data;
};

/** Empty the stash. Exposed for test isolation. */
export const clearFormStash = (): void => {
  store.clear();
};
