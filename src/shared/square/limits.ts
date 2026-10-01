/**
 * Limits of the Square link expiry task. Each registered limit lands in the
 * debug table through the same declaration as its named constant, so the two
 * can never drift (see `#shared/limits.ts`).
 */

import { limit } from "#shared/limits.ts";
import { DAY_MS } from "#shared/now.ts";

/**
 * How many Square payment links one expiry run may take (default: 10). Each
 * costs one Square delete, so this is what keeps the task inside the edge
 * subrequest budget.
 */
export const SQUARE_LINK_EXPIRY_BATCH = limit(
  "SQUARE_LINK_EXPIRY_BATCH",
  10,
  "Square link expiry: links per run",
  "links",
);

/**
 * How often the Square link expiry task looks for due links (default: 5
 * minutes). The window decides when a link is due; this only decides how
 * promptly a due link is picked up.
 */
export const SQUARE_LINK_EXPIRY_INTERVAL_MINUTES = limit(
  "SQUARE_LINK_EXPIRY_INTERVAL_MINUTES",
  5,
  "Square link expiry: how often to look for due links",
  "minutes",
);

/** How long a claimed link end may sit without an answer before its lease
 * expires and the row returns to the queue. */
export const SQUARE_LINK_LEASE_MS = 5 * 60 * 1000;

/** How long to wait before asking Square again about a link whose delete
 * answer proved nothing. */
export const SQUARE_LINK_RETRY_MS = 5 * 60 * 1000;

/** Computed: the expiry task interval in milliseconds. */
export const SQUARE_LINK_EXPIRY_INTERVAL_MS =
  SQUARE_LINK_EXPIRY_INTERVAL_MINUTES * 60 * 1000;

/** How long Square itself keeps an unpaid payment link payable: 180 days
 * from its creation. A handle row older than this plus the webhook window
 * can no longer take payment, whatever this task did. */
export const SQUARE_NATIVE_LIFETIME_MS = 180 * DAY_MS;
