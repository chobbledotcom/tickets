/**
 * Naming the payment rows that stand in for a charge rather than record a
 * checkout.
 *
 * This module is pure, and deliberately depends on nothing: both the code that
 * mints anchors and the code that reads payment references need to recognise
 * one, and neither should have to import the other to do it.
 */

const ANCHOR_SESSION_PREFIX = "legacy:";

/**
 * The older spelling, written by merges before anchors were minted for legacy
 * charges generally. Rows carrying it are still out there, so it is still
 * recognised — nothing writes it any more.
 */
const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/**
 * The session id of one attendee's anchor for one charge.
 *
 * Both parts are needed. The attendee alone would clash if their legacy charge
 * were ever replaced by another, and the charge alone would make two people who
 * share one charge fight over a single row — each needs their own, because each
 * is claimed separately.
 */
export const anchorSessionId = (attendeeId: number, index: string): string =>
  `${ANCHOR_SESSION_PREFIX}${attendeeId}:${index}`;

/**
 * Whether this row stands in for a charge rather than recording a checkout.
 *
 * Anchors carry no real payment session, so anything counting a run's actual
 * checkouts leaves them out — and anything comparing a claim's rows against a
 * loaded reference list has to know they were left out on purpose.
 */
export const isAnchorSession = (sessionId: string): boolean =>
  sessionId.startsWith(ANCHOR_SESSION_PREFIX) ||
  sessionId.startsWith(LEGACY_MERGE_SESSION_PREFIX);

/** The session id a merge writes for a legacy payment it is carrying over. */
export const legacyMergeSessionId = (sourceId: number): string =>
  `${LEGACY_MERGE_SESSION_PREFIX}${sourceId}`;
