/** Backfill `transfers.reverses_group` — the booking order each refund leg
 *  reverses — onto rows posted before the column existed.
 *
 * Every refund leg is posted by {@link mapRefund}, which derives the refund
 * event's group as `refundEventGroup(bookingGroup)` from one order's own legs.
 * The derivation is deterministic, so re-computing it here attributes every
 * stored refund leg exactly; anything left over is data no derivation can
 * name, and the caller refuses rather than guess.
 */

import { refundEventGroup } from "#accounting/mappers.ts";
import {
  executeBatch,
  queryAllPrimary,
  type SqlStatement,
} from "#db/client.ts";
import { chunk } from "#fp";

/** One (refund group → booking group) attribution. */
type ReversesPair = readonly [refundGroup: string, bookingGroup: string];

/** Pairs per UPDATE statement — two bound args per pair keeps every statement
 * far below libsql's 32,766-variable ceiling with room for the page to grow. */
const PAIRS_PER_PAGE = 5000;

/** Refund legs are exactly the `refund_`-prefixed kinds (`refundKind` prefixes
 * every mapped reversal); GLOB keeps `_` literal, unlike LIKE. */
const REFUND_KIND_GLOB = "refund_*";

/**
 * The pages of `event_group = ?`-paired CASE arms that stamp every refund leg
 * with the order it reverses. One statement per page, so the whole backfill is
 * a handful of round-trips whatever the ledger's size.
 */
const reversesStatements = (pairs: ReversesPair[]): SqlStatement[] =>
  chunk(PAIRS_PER_PAGE)(pairs).map((page) => ({
    args: page.flatMap(([refundGroup, bookingGroup]) => [
      refundGroup,
      bookingGroup,
    ]),
    sql:
      "UPDATE transfers SET reverses_group = CASE event_group" +
      ` ${page.map(() => "WHEN ? THEN ?").join(" ")}` +
      " ELSE reverses_group END" +
      ` WHERE kind GLOB '${REFUND_KIND_GLOB}' AND reverses_group = ''`,
  }));

/** Read every distinct event group whose legs meet `condition`. */
const eventGroupsWhere = (
  condition: string,
): Promise<{ event_group: string }[]> =>
  queryAllPrimary<{ event_group: string }>({
    args: [],
    sql: `SELECT DISTINCT event_group FROM transfers WHERE ${condition}`,
  });

/**
 * Attribute every stored refund leg to the booking order it reversed.
 * Idempotent: only still-empty links are written. Refuses, naming the orphan
 * refund groups, when a refund leg cannot be attributed — ledger rows nothing
 * derivable names are operator-repairable data, never a silent guess.
 */
export const backfillReversesGroup = async (): Promise<void> => {
  const refundKind = `kind GLOB '${REFUND_KIND_GLOB}'`;
  const [storedGroups, storedRefundGroups] = await Promise.all([
    eventGroupsWhere(`NOT ${refundKind}`),
    eventGroupsWhere(refundKind),
  ]);
  const refundGroups = new Set(
    storedRefundGroups.map((row) => row.event_group),
  );
  const pairs: ReversesPair[] = [];
  for (const { event_group: group } of storedGroups) {
    const refundGroup = await refundEventGroup(group);
    if (refundGroups.has(refundGroup)) pairs.push([refundGroup, group]);
  }
  const statements = reversesStatements(pairs);
  if (statements.length > 0) await executeBatch(statements);

  const orphans = await eventGroupsWhere(
    `${refundKind} AND reverses_group = ''`,
  );
  if (orphans.length > 0) {
    throw new Error(
      "refund legs with no booking order they reverse: " +
        orphans.map((row) => row.event_group).join(", ") +
        " — repair the orphaned refund legs or their missing order, then re-run",
    );
  }
};
