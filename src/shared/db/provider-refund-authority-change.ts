/** Revision-fenced changes to the one provider-refund authority. */

/* jscpd:ignore-start -- imports */
import { execute, type TxScope } from "#shared/db/client.ts";
import {
  loadRefundAuthorityById,
  REFUND_AUTHORITY_COLUMNS,
  type RefundAuthorityRow,
  type RefundAuthorityVersion,
  refundAuthorityFromResult,
} from "#shared/db/provider-refund-authority.ts";
import type { Money } from "#shared/payment/money.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority.ts";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
/* jscpd:ignore-end */

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

const stateWrite = (
  state: RefundAuthorityState,
  revision: number,
  now: number,
): readonly (string | number | null)[] => [
  writeRefundAuthorityState(state, "payment_charges.refund_state"),
  refundStateMirror(state),
  refundLocalMirror(state),
  refundNextActionAt(state),
  revision + 1,
  now,
  now,
];

const changeRefundAuthorityStatement = (
  row: RefundAuthorityVersion,
  state: RefundAuthorityState,
  money: RefundAuthorityMoney,
  now: number,
): { readonly args: (string | number | null)[]; readonly sql: string } => {
  requireRefundMoney(row, money);
  return {
    args: [
      money.captured.amount,
      money.captured.currency,
      money.refunded.amount,
      ...stateWrite(state, row.revision, now),
      row.id,
      row.revision,
    ],
    sql: `UPDATE payment_charges
             SET captured_amount = ?, currency = ?, refunded_amount = ?,
                 refund_state = ?, refund_state_name = ?,
                 refund_local_state = ?, next_refund_action_at = ?,
                 refund_revision = ?, updated_at = ?, observed_at = ?
           WHERE id = ? AND refund_revision = ?
       RETURNING ${REFUND_AUTHORITY_COLUMNS}`,
  };
};

type RefundAuthorityStatement = ReturnType<
  typeof changeRefundAuthorityStatement
>;
type RefundAuthorityWriter = (
  statement: RefundAuthorityStatement,
) => ReturnType<TxScope["execute"]>;

const executeRefundAuthorityStatement: RefundAuthorityWriter = ({
  args,
  sql,
}) => execute(sql, args);

const changeRefundAuthority = async (
  row: RefundAuthorityVersion,
  transition: RefundTransition,
  money: RefundAuthorityMoney,
  now: number,
  write: RefundAuthorityWriter = executeRefundAuthorityStatement,
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
