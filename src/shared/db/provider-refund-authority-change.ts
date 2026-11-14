/** Revision-fenced changes to the one provider-refund authority. */

import { execute, type TxScope } from "#db/client.ts";
import {
  loadRefundAuthorityById,
  REFUND_AUTHORITY_COLUMNS,
  type RefundAuthorityRow,
  type RefundAuthorityVersion,
  refundAuthorityFromResult,
} from "#db/provider-refund-authority.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import type { Money } from "#payment/money.ts";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
} from "#payment/refund-authority.ts";
import {
  type RefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#payment/refund-authority-state.ts";

export type RefundAuthorityMoney = Pick<
  RefundAuthorityRow,
  "captured" | "refunded"
>;

type RefundTransition = (state: RefundAuthorityState) => RefundAuthorityState;

const requireRefundMoney = (
  row: RefundAuthorityMoney,
  money: RefundAuthorityMoney,
): void => {
  if (
    money.captured.currency !== row.captured.currency ||
    money.refunded.currency !== money.captured.currency
  ) {
    throw new Error("Refund authority money currency changed");
  }
  if (money.captured.amount < 1) {
    throw new Error("Refund authority captured amount must be positive");
  }
  if (money.refunded.amount < row.refunded.amount) {
    throw new Error("Refund authority refunded amount moved backwards");
  }
  if (money.refunded.amount > money.captured.amount) {
    throw new Error("Refund authority refunded amount exceeds its capture");
  }
};

const changeRefundAuthorityStatement = (
  row: RefundAuthorityVersion,
  state: RefundAuthorityState,
  money: RefundAuthorityMoney,
  now: number,
): SqlStatement => {
  requireRefundMoney(row, money);
  return sql`UPDATE payment_charges
             SET captured_amount = ${money.captured.amount}, currency = ${money.captured.currency}, refunded_amount = ${money.refunded.amount},
                 refund_state = ${writeRefundAuthorityState(state, "payment_charges.refund_state")}, refund_state_name = ${refundStateMirror(state)},
                 refund_local_state = ${refundLocalMirror(state)}, next_refund_action_at = ${refundNextActionAt(state)},
                 refund_revision = ${row.revision + 1}, updated_at = ${now}, observed_at = ${now}
           WHERE id = ${row.id} AND refund_revision = ${row.revision}
       RETURNING ${REFUND_AUTHORITY_COLUMNS}`;
};

type RefundAuthorityWriter = (
  statement: SqlStatement,
) => ReturnType<TxScope["execute"]>;

const changeRefundAuthority = async (
  row: RefundAuthorityVersion,
  transition: RefundTransition,
  money: RefundAuthorityMoney,
  now: number,
  write: RefundAuthorityWriter = execute,
): Promise<RefundAuthorityRow | null> =>
  refundAuthorityFromResult(
    await write(
      changeRefundAuthorityStatement(row, transition(row.state), money, now),
    ),
  );

/** Replace one already-read revision in one database statement. */
export const transitionRefundAuthority = async (
  row: RefundAuthorityVersion,
  now: number,
  refunded: Money,
  transition: RefundTransition,
): Promise<RefundAuthorityRow | null> =>
  await changeRefundAuthority(
    row,
    transition,
    { captured: row.captured, refunded },
    now,
  );

/** Resolve one owner decision and its exact money in the same revision-fenced
 * statement. */
export const resolveRefundAuthorityMoney = async ({
  money,
  now,
  row,
  transaction,
  transition,
}: {
  readonly money: RefundAuthorityMoney;
  readonly now: number;
  readonly row: RefundAuthorityVersion;
  readonly transaction: TxScope;
  readonly transition: RefundTransition;
}): Promise<RefundAuthorityRow | null> =>
  await changeRefundAuthority(row, transition, money, now, (statement) =>
    transaction.execute(statement),
  );

/** Persist provider completion for the exact authority revision. */
export const completeRefundAuthority = (
  row: RefundAuthorityVersion,
  refunded: Money,
  now: number,
  proof: "owner" | "provider",
): Promise<RefundAuthorityRow | null> =>
  transitionRefundAuthority(row, now, refunded, (state) =>
    markRefundCompleted(state, now, proof),
  );

/** Finish local bookkeeping only for the exact completed revision. */
export const markRefundAuthorityRecorded = async (
  id: number,
  expectedRevision: number,
  now: number,
): Promise<RefundAuthorityRow | null> => {
  const row = await loadRefundAuthorityById(id);
  return row === null || row.revision !== expectedRevision
    ? null
    : row.state.kind === "completed" && row.state.local.kind === "recorded"
      ? row
      : transitionRefundAuthority(row, now, row.refunded, (state) =>
          markRefundLocalRecorded(state, now),
        );
};
