/** Backfill `transfers.reverses_group` — the booking order each refund leg
 *  reverses — onto rows posted before the column existed.
 *
 * Every refund leg is posted by {@link mapRefund}, which derives the refund
 * event's group as `refundEventGroup(bookingGroup)` from one order's own legs.
 * The derivation is deterministic, so re-computing it here attributes every
 * stored refund leg exactly; anything left over is data no derivation can
 * name, and the caller refuses rather than guess.
 *
 * The scan runs in keyset pages on the event-group index, checkpointed into
 * settings after each page, so a stopped run resumes rather than re-walking.
 */

import type { InValue } from "@libsql/client";
import { refundEventGroup } from "#accounting/mappers.ts";
import {
  executeBatch,
  inPlaceholders,
  queryAllPrimary,
  queryOnePrimary,
  type SqlStatement,
} from "#db/client.ts";

/** One (refund group → booking group) attribution. */
type ReversesPair = readonly [refundGroup: string, bookingGroup: string];

/** Keyset page of event groups, and pairs per UPDATE statement. Both keep
 *  every statement far below libsql's 32,766-variable ceiling. */
const GROUP_PAGE = 5000;

/** Refund legs are exactly the `refund_`-prefixed kinds (`refundKind` prefixes
 *  every mapped reversal); GLOB keeps `_` literal, unlike LIKE. */
const REFUND_KIND_GLOB = "refund_*";

/** The settings row holding the walk's resumed position. A stopped run
 *  leaves it behind; a finished run deletes it. */
const CURSOR_KEY = "backfill_reverses_group_cursor";

/** One page of distinct event groups meeting `condition`, keyed past the
 *  page's start, in index order. */
const eventGroupsPage = (
  pageSize: number,
  condition: string,
  conditionArgs: readonly InValue[],
): Promise<{ event_group: string }[]> =>
  queryAllPrimary<{ event_group: string }>({
    args: [...conditionArgs, pageSize],
    sql:
      "SELECT DISTINCT event_group FROM transfers" +
      ` WHERE ${condition} ORDER BY event_group LIMIT ?`,
  });

/** Keyset cursor over the event-group index. Branded, so a plain `+=`
 *  concatenation of two cursors is a type error instead of a page replay. */
type GroupCursor = string & { readonly is: "GroupCursor" };

const cursorOf = (group: string): GroupCursor => group as GroupCursor;

/** Every page's last group becomes the next cursor, brand-checked above. */
const cursorAfter = (page: readonly { event_group: string }[]): GroupCursor =>
  cursorOf(page[page.length - 1]!.event_group);

/** The pairs of one booking-group page whose refund event actually exists. */
const pagePairs = async (
  pageSize: number,
  bookingGroups: readonly string[],
): Promise<ReversesPair[]> => {
  const refundGroupOf = await Promise.all(
    bookingGroups.map((group) => refundEventGroup(group)),
  );
  const stored = await eventGroupsPage(
    pageSize,
    `kind GLOB '${REFUND_KIND_GLOB}' AND event_group IN (${inPlaceholders(
      refundGroupOf,
    )})`,
    refundGroupOf,
  );
  const storedGroups = new Set(stored.map((row) => row.event_group));
  return bookingGroups
    .map((group, index) => [refundGroupOf[index]!, group] as const)
    .filter(([refundGroup]) => storedGroups.has(refundGroup));
};

/** Stamp one page's pairs in a single UPDATE, joining each refund event's
 *  legs through the event-group index. */
const pageUpdate = (pairs: readonly ReversesPair[]): SqlStatement => ({
  args: pairs.flat(),
  sql:
    "WITH pairs(refund_group, booking_group) AS (VALUES" +
    ` ${pairs.map(() => "(?, ?)").join(", ")})` +
    " UPDATE transfers SET reverses_group = pairs.booking_group" +
    " FROM pairs" +
    " WHERE transfers.event_group = pairs.refund_group" +
    ` AND transfers.kind GLOB '${REFUND_KIND_GLOB}'` +
    " AND transfers.reverses_group = ''",
});

/** Every refund group still carrying an unattributed leg, page by page. */
const unattributedRefundGroups = async (
  pageSize: number,
): Promise<string[]> => {
  const orphans: string[] = [];
  let after = cursorOf("");
  for (;;) {
    const page = await eventGroupsPage(
      pageSize,
      `kind GLOB '${REFUND_KIND_GLOB}' AND reverses_group = '' AND event_group > ?`,
      [after],
    );
    if (page.length === 0) return orphans;
    after = cursorAfter(page);
    orphans.push(...page.map((row) => row.event_group));
  }
};

/** The walk's resumed position, or '' when the run starts fresh. */
const readCursor = async (): Promise<GroupCursor> => {
  const row = await queryOnePrimary<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CURSOR_KEY],
  );
  return cursorOf(row?.value ?? "");
};

/** Checkpoint the walk so a budget-stopped retry resumes here, never before. */
const saveCursor = (after: GroupCursor): Promise<unknown> =>
  executeBatch([
    {
      args: [CURSOR_KEY, after],
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    },
  ]);

/** A finished run leaves no checkpoint behind. */
const clearCursor = (): Promise<unknown> =>
  executeBatch([
    {
      args: [CURSOR_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    },
  ]);

/**
 * Attribute every stored refund leg to the booking order it reversed.
 * Idempotent: only still-empty links are written. Refuses, naming the orphan
 * refund groups, when a refund leg cannot be attributed — ledger rows nothing
 * derivable names are operator-repairable data, never a silent guess.
 *
 * `pageSize` (the per-page group count, defaulting to the edge-budget
 * {@link GROUP_PAGE}) is lowered in tests to exercise the multi-page cursor
 * and the resume checkpoint.
 */
export const backfillReversesGroup = async (
  pageSize: number = GROUP_PAGE,
): Promise<void> => {
  let after = await readCursor();
  for (;;) {
    const bookingGroups = await eventGroupsPage(
      pageSize,
      `kind NOT GLOB '${REFUND_KIND_GLOB}' AND event_group > ?`,
      [after],
    );
    if (bookingGroups.length === 0) break;
    after = cursorAfter(bookingGroups);
    const pairs = await pagePairs(
      pageSize,
      bookingGroups.map((row) => row.event_group),
    );
    if (pairs.length > 0) await executeBatch([pageUpdate(pairs)]);
    await saveCursor(after);
  }

  const orphans = await unattributedRefundGroups(pageSize);
  // Clear the checkpoint before any refusal: an operator repairs an orphan by
  // restoring legs that sit BEFORE the walked cursor, so leaving the checkpoint
  // would make the retried walk skip the repaired region forever.
  await clearCursor();
  if (orphans.length > 0) {
    throw new Error(
      "refund legs with no booking order they reverse: " +
        orphans.join(", ") +
        " — repair the orphaned refund legs or their missing order, then re-run",
    );
  }
};
