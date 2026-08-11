/**
 * Naming the payment rows that stand in for a charge rather than record a
 * checkout. Pure, and deliberately depends on nothing: both the code that
 * mints anchors and the code that reads references must recognise one, and
 * neither should have to import the other to do it.
 */

const ANCHOR_SESSION_PREFIX = "legacy:";

/** The older spelling, from before anchors were minted for legacy charges
 *  generally. Still recognised because such rows are still out there. */
const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/** The session id of one attendee's anchor for one charge. Both parts are
 *  needed: the attendee alone would clash if their legacy charge were
 *  replaced, and the charge alone would make two people who share it fight
 *  over one row, when each is claimed separately. */
export const anchorSessionId = (attendeeId: number, index: string): string =>
  `${ANCHOR_SESSION_PREFIX}${attendeeId}:${index}`;

/** Whether this row stands in for a charge rather than recording a checkout.
 *  Anchors carry no real payment session, so anything comparing a claim's rows
 *  against a loaded reference list must know they are left out on purpose. */
export const isAnchorSession = (sessionId: string): boolean =>
  sessionId.startsWith(ANCHOR_SESSION_PREFIX) ||
  sessionId.startsWith(LEGACY_MERGE_SESSION_PREFIX);

/** The session id a merge writes for a legacy payment it is carrying over. */
export const legacyMergeSessionId = (sourceId: number): string =>
  `${LEGACY_MERGE_SESSION_PREFIX}${sourceId}`;
