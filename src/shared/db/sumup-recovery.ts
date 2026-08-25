/**
 * The queue of staged SumUp checkouts waiting to be asked about, and the
 * one fenced write that moves a row along it: an answer moves its state, a
 * failure moves only its clock.
 *
 * Which rows are due, where an event moves them, and what each event's write
 * matches on all come from the machine declaration in
 * `shared/payment/sumup-recovery-machine-spec.ts` — this module holds only the
 * SQL that carries it out.
 */

import {
  execute,
  inPlaceholders,
  queryAll,
  queryBatch,
  resultRows,
} from "#db/client.ts";
import { SCAN_LIMIT } from "#db/schema-anomaly-scan.ts";
import {
  parseSumupRecoveryState,
  RECOVERY_CHECKABLE_NODES,
  RECOVERY_UNANSWERED_NODES,
  RECOVERY_UNANSWERED_WHEN_OLD_NODES,
  type RecoveryEventId,
  type RecoveryNodeId,
  recoveryMoveTo,
  recoveryNodeOf,
} from "#payment/sumup-recovery-machine-spec.ts";
import {
  SUMUP_RECHECK_MS,
  SUMUP_RECOVERY_BATCH,
  SUMUP_UNANSWERED_AFTER_MS,
} from "#shared/limits.ts";
import { isoAfter, isoBefore, nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";

/** One checkout the recovery task is about to ask SumUp about. The metadata
 * stays sealed: this is the queue, not the opening of a row. */
export type DueSumupCheckout = {
  readonly checkedAt: string;
  /** The row's own index — the primary key, so a write can never name two
   * rows even if the provider reused a checkout id. */
  readonly referenceIndex: string;
  readonly state: RecoveryNodeId;
  readonly sumupId: string;
};

const CHECKABLE_SLOTS = inPlaceholders(RECOVERY_CHECKABLE_NODES);

/**
 * The oldest checkouts whose check time has come, newest-last so a row that
 * keeps failing cannot hold the front of the queue: its own check time moves
 * forward every time it is looked at, which puts it behind everything that
 * became due in the meantime.
 */
export const getDueSumupCheckouts = async (): Promise<DueSumupCheckout[]> => {
  const rows = await queryAll<{
    next_check_at: string;
    reference_index: string;
    recovery_state: string;
    sumup_id: string;
  }>(
    `SELECT reference_index, sumup_id, recovery_state, next_check_at
       FROM sumup_checkouts
      WHERE recovery_state IN (${CHECKABLE_SLOTS})
        AND next_check_at IS NOT NULL
        AND next_check_at <= ?
      ORDER BY next_check_at
      LIMIT ?`,
    [...RECOVERY_CHECKABLE_NODES, nowIso(), SUMUP_RECOVERY_BATCH],
  );
  // Reading the stored word back through the machine is what turns a row
  // nothing here could have written into a raised error rather than work.
  return rows.map((row) => ({
    checkedAt: row.next_check_at,
    referenceIndex: row.reference_index,
    state: recoveryNodeOf({
      recoveryState: parseSumupRecoveryState(row.recovery_state),
      sumupId: row.sumup_id,
    }),
    sumupId: row.sumup_id,
  }));
};

/** Move a row to a state and a check time, but only where it is still
 * exactly as it was read: the write names the row by its own index and
 * matches the state and check time it was read with, so two runners that
 * looked at one row cannot both believe they wrote it — the loser finds no
 * row. */
const moveSumupRecoveryRow = async (
  checkout: DueSumupCheckout,
  recoveryState: RecoveryNodeId,
  nextCheckAt: string | null,
): Promise<number> => {
  const result = await execute(
    `UPDATE sumup_checkouts
        SET recovery_state = ?, next_check_at = ?
      WHERE reference_index = ? AND recovery_state = ? AND next_check_at = ?`,
    [
      recoveryState,
      nextCheckAt,
      checkout.referenceIndex,
      checkout.state,
      checkout.checkedAt,
    ],
  );
  return result.rowsAffected;
};

/**
 * Move one row on by the event its check amounted to.
 *
 * The row keeps a next check time exactly while its state is one the queue
 * still asks about — the same declared list the queue and the live check
 * read. A state off that list is given no next check: nothing will ask
 * about it again, and pruning is free to delete it once it is old enough.
 */
export const applySumupRecoveryEvent = async (
  checkout: DueSumupCheckout,
  event: RecoveryEventId,
): Promise<boolean> => {
  const to = recoveryMoveTo(checkout.state, event);
  const checkable = RECOVERY_CHECKABLE_NODES.includes(to);
  return (
    (await moveSumupRecoveryRow(
      checkout,
      to,
      checkable ? isoAfter(SUMUP_RECHECK_MS) : null,
    )) === 1
  );
};

/**
 * Push one row's next check further out without saying anything about it. A
 * check that blew up gave no answer, so its state is written back unchanged
 * and only the clock moves — or a row that keeps failing would hold the
 * front of the queue forever.
 */
export const delaySumupRecoveryCheck = async (
  checkout: DueSumupCheckout,
): Promise<void> => {
  await moveSumupRecoveryRow(
    checkout,
    checkout.state,
    isoAfter(SUMUP_RECHECK_MS),
  );
};

/** One checkout the operator must hear about, oldest first. */
export type UnansweredSumupRow = {
  readonly createdAt: string;
  readonly referenceIndex: string;
  readonly state: RecoveryNodeId;
};

/** Every checkout that may be holding money nobody has answered for: the
 * whole count, and a bounded oldest-first sample of the rows. */
export type UnansweredSumupMoney = {
  readonly rows: readonly UnansweredSumupRow[];
  readonly total: number;
};

/** The listed states come from the machine declaration: `owed` rows always,
 * `waiting` rows once they are old. `created_at` is the clock on purpose —
 * the check time moves forward after every attempt, so a row nothing can
 * answer (or a task that cannot run at all) never looks overdue by it. */
const UNANSWERED_WHERE = `(recovery_state IN (${inPlaceholders(
  RECOVERY_UNANSWERED_NODES,
)})
    OR (recovery_state IN (${inPlaceholders(RECOVERY_UNANSWERED_WHEN_OLD_NODES)})
        AND created_at < ?))`;

interface UnansweredCountRow {
  readonly total: number;
}

interface UnansweredListRow {
  readonly created_at: string;
  readonly recovery_state: string;
  readonly reference_index: string;
}

/**
 * Count and sample the checkouts nobody has answered for, for the system
 * map. Bounded: the count is exact, the rows stop at the shared listing
 * limit so one bad week cannot make the page unreadable.
 */
export const listUnansweredSumupMoney =
  async (): Promise<UnansweredSumupMoney> => {
    const args = [
      ...RECOVERY_UNANSWERED_NODES,
      ...RECOVERY_UNANSWERED_WHEN_OLD_NODES,
      isoBefore(SUMUP_UNANSWERED_AFTER_MS),
    ];
    const [countResult, listResult] = await queryBatch([
      {
        args: [...args],
        sql: `SELECT COUNT(*) AS total FROM sumup_checkouts
         WHERE ${UNANSWERED_WHERE}`,
      },
      {
        args: [...args, SCAN_LIMIT],
        sql: `SELECT reference_index, recovery_state, created_at
          FROM sumup_checkouts
         WHERE ${UNANSWERED_WHERE}
         ORDER BY created_at
         LIMIT ?`,
      },
    ]);
    const counted = requireValue(
      countResult,
      "The unanswered SumUp count returned no result",
    );
    const total = requireValue(
      resultRows<UnansweredCountRow>(counted)[0],
      "The unanswered SumUp count returned no row",
    ).total;
    const listed = requireValue(
      listResult,
      "The unanswered SumUp listing returned no result",
    );
    const rows = resultRows<UnansweredListRow>(listed).map((row) => ({
      createdAt: row.created_at,
      referenceIndex: row.reference_index,
      state: parseSumupRecoveryState(row.recovery_state),
    }));
    return { rows, total };
  };
