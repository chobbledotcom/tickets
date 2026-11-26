/// <reference lib="dom" />
// effects: pure
/** The scanner's keys in the browser's store, and the two ways the browser
 * can refuse that store. The scanner page reads and writes these keys. The
 * login page clears the ones that hold guest names. */

/** One door's saved ticket list, under the door's scan path. It holds
 * guest names. */
export const TICKETS_KEY_PREFIX = "scanner-tickets-";

/** One door's offline switch, under the door's scan path. */
export const MODE_KEY_PREFIX = "scanner-offline-mode-";

/** The queued check-ins of every door on this device. They hold ticket
 * digests and no guest names. */
export const QUEUE_KEY = "scanner-queue";

/** The prefixes of the keys that name a door's guests. Sign-out clears
 * them. */
export const GUEST_KEY_PREFIXES = [TICKETS_KEY_PREFIX, MODE_KEY_PREFIX];

/** Whether an error is the browser's own refusal with this name. */
const isRefusal =
  (name: string) =>
  (error: unknown): boolean =>
    error instanceof DOMException && error.name === name;

/** Whether an error is the browser refusing a write because the site's
 * store is full. */
export const isStoreFull = isRefusal("QuotaExceededError");

/** Whether an error is the browser blocking site data for this page. */
export const isStoreBlocked = isRefusal("SecurityError");

/** Run `use` on the page's store, or answer `blocked` when the browser
 * blocks site data for this page. A blocked store is a documented state
 * that the online scanner works without. Any other error still throws. */
export const withStoreOr = <T>(use: (store: Storage) => T, blocked: T): T => {
  try {
    return use(localStorage);
  } catch (error) {
    if (isStoreBlocked(error)) return blocked;
    throw error;
  }
};
