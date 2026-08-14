/** Atomic storage for the one provider-refund authority. */

/* jscpd:ignore-start -- imports */
import { execute, queryAll, queryOne, resultRows } from "#shared/db/client.ts";
import { storePaymentReference } from "#shared/db/payment-reference-store.ts";
import type { Money } from "#shared/payment/money.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority.ts";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
  readRefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
import type { RefundProviderCapability } from "#shared/payment/refund-provider-authorization.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#shared/payment/refund-provider-authorization.ts";
import type { PaymentProviderType } from "#shared/types.ts";
/* jscpd:ignore-end */

export type RefundAuthorityRow = {
  readonly callbackReplayIndex: string | null;
  readonly captured: Money;
  readonly id: number;
  readonly provider: PaymentProviderType;
  readonly referenceIndex: string;
  readonly refunded: Money;
  readonly revision: number;
  readonly state: RefundAuthorityState;
};

export type RefundAuthorityVersion = Pick<
  RefundAuthorityRow,
  "captured" | "id" | "referenceIndex" | "refunded" | "revision" | "state"
>;

type StoredRefundAuthorityRow = {
  callback_replay_index: string | null;
  captured_amount: number;
  currency: Money["currency"];
  id: number;
  provider: PaymentProviderType;
  reference_index: string;
  refunded_amount: number;
  refund_revision: number;
  refund_state: string;
};

const AUTHORITY_COLUMNS = `id, provider, reference_index,
  callback_replay_index, captured_amount, currency, refunded_amount,
  refund_state, refund_revision`;

const authorityRow = (row: StoredRefundAuthorityRow): RefundAuthorityRow => ({
  callbackReplayIndex: row.callback_replay_index,
  captured: { amount: Number(row.captured_amount), currency: row.currency },
  id: Number(row.id),
  provider: row.provider,
  referenceIndex: row.reference_index,
  refunded: { amount: Number(row.refunded_amount), currency: row.currency },
  revision: Number(row.refund_revision),
  state: readRefundAuthorityState(
    row.refund_state,
    `payment_charges ${row.id}`,
  ),
});

const oneAuthority = (
  rows: readonly StoredRefundAuthorityRow[],
): RefundAuthorityRow | null => {
  if (rows.length > 1) {
    throw new Error("Refund identity resolved to more than one charge");
  }
  return rows[0] === undefined ? null : authorityRow(rows[0]);
};

const authorityFromResult = (
  result: Parameters<typeof resultRows>[0],
): RefundAuthorityRow | null =>
  oneAuthority(resultRows<StoredRefundAuthorityRow>(result));

const loadRefundAuthority = async (
  field: "id" | "reference_index",
  value: number | string,
): Promise<RefundAuthorityRow | null> => {
  const row = await queryOne<StoredRefundAuthorityRow>(
    `SELECT ${AUTHORITY_COLUMNS}
       FROM payment_charges
      WHERE ${field} = ?`,
    [value],
  );
  return row === null ? null : authorityRow(row);
};

/** Load one charge through its globally unique blind identity. */
export const loadRefundAuthorityByReference = (
  referenceIndex: string,
): Promise<RefundAuthorityRow | null> =>
  loadRefundAuthority("reference_index", referenceIndex);

/** Load one charge through its local row id. */
export const loadRefundAuthorityById = (
  id: number,
): Promise<RefundAuthorityRow | null> => loadRefundAuthority("id", id);

interface RefundCallbackBinding {
  readonly callbackReplayIndex: string;
  readonly referenceIndex: string;
}

const loadRefundCallbackBinding = async ({
  callbackReplayIndex,
  referenceIndex,
}: RefundCallbackBinding): Promise<RefundAuthorityRow | null> => {
  const owners = await queryAll<StoredRefundAuthorityRow>(
    `SELECT ${AUTHORITY_COLUMNS}
       FROM payment_charges
      WHERE reference_index = ? OR callback_replay_index = ?`,
    [referenceIndex, callbackReplayIndex],
  );
  if (owners.length === 0) return null;
  if (owners.length === 1) {
    const owner = authorityRow(owners[0]!);
    if (
      owner.referenceIndex === referenceIndex &&
      owner.callbackReplayIndex === callbackReplayIndex
    ) {
      return owner;
    }
  }
  throw new Error("Refund callback identity belongs to another charge");
};

/** Bind one callback identity to its charge, or prove that the same binding
 * already exists. The unique index and conditional write prevent two charges
 * from owning one callback. */
export const bindRefundCallbackIfChargeExists = async (
  binding: RefundCallbackBinding,
): Promise<RefundAuthorityRow | null> => {
  const { callbackReplayIndex, referenceIndex } = binding;
  const changed = authorityFromResult(
    await execute(
      `UPDATE payment_charges
          SET callback_replay_index = COALESCE(callback_replay_index, ?)
        WHERE reference_index = ?
          AND callback_replay_index IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM payment_charges AS callbackOwner
             WHERE callbackOwner.callback_replay_index = ?
               AND callbackOwner.reference_index <> ?
          )
      RETURNING ${AUTHORITY_COLUMNS}`,
      [
        callbackReplayIndex,
        referenceIndex,
        callbackReplayIndex,
        referenceIndex,
      ],
    ),
  );
  if (changed !== null) return changed;
  return await loadRefundCallbackBinding(binding);
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

export interface CreateRefundAuthority {
  readonly callbackReplayIndex?: string | undefined;
  readonly capability: RefundProviderCapability;
  readonly captured: Money;
  readonly now: number;
  readonly reference: TaggedPaymentReference;
  readonly state: Extract<RefundAuthorityState, { kind: "ready" }>;
}

const requireCreateFacts = (input: CreateRefundAuthority): void => {
  if (
    input.state.request.capability !== input.capability ||
    REFUND_PROVIDER_CAPABILITIES[input.reference.provider] !== input.capability
  ) {
    throw new Error("Refund authority facts disagree");
  }
};

const requireSameAuthority = (
  row: RefundAuthorityRow,
  input: CreateRefundAuthority,
  referenceIndex: string,
): void => {
  if (
    row.referenceIndex !== referenceIndex ||
    row.provider !== input.reference.provider ||
    row.state.request.capability !== input.capability ||
    (input.callbackReplayIndex !== undefined &&
      row.callbackReplayIndex !== input.callbackReplayIndex)
  ) {
    throw new Error("Refund identity belongs to different charge facts");
  }
};

/** Create the charge authority once, then return the row owning its identity. */
export const createOrLoadRefundAuthority = async (
  input: CreateRefundAuthority,
): Promise<RefundAuthorityRow> => {
  requireCreateFacts(input);
  const stored = await storePaymentReference(input.reference);
  const result = await execute(
    `INSERT INTO payment_charges
        (provider, provider_reference, reference_index, callback_replay_index,
         capability, captured_amount, currency, refunded_amount, refund_state,
         refund_state_name, refund_local_state, next_refund_action_at,
         refund_revision, created_at, updated_at, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          callback_replay_index = COALESCE(
            payment_charges.callback_replay_index,
            excluded.callback_replay_index
          )
        WHERE payment_charges.reference_index = excluded.reference_index
          AND (
            excluded.callback_replay_index IS NULL OR
            payment_charges.callback_replay_index IS NULL OR
            payment_charges.callback_replay_index = excluded.callback_replay_index
          )
          AND NOT EXISTS (
            SELECT 1
              FROM payment_charges AS callbackOwner
             WHERE callbackOwner.callback_replay_index = excluded.callback_replay_index
               AND callbackOwner.reference_index <> excluded.reference_index
          )
        RETURNING ${AUTHORITY_COLUMNS}`,
    [
      input.reference.provider,
      stored.encrypted,
      stored.index,
      input.callbackReplayIndex ?? null,
      input.capability,
      input.captured.amount,
      input.captured.currency,
      0,
      writeRefundAuthorityState(input.state),
      refundStateMirror(input.state),
      refundLocalMirror(input.state),
      refundNextActionAt(input.state),
      1,
      input.now,
      input.now,
      input.now,
    ],
  );
  const returned = authorityFromResult(result);
  const row =
    returned ??
    (input.callbackReplayIndex === undefined
      ? null
      : await loadRefundCallbackBinding({
          callbackReplayIndex: input.callbackReplayIndex,
          referenceIndex: stored.index,
        }));
  if (row === null) throw new Error("Created refund authority is missing");
  requireSameAuthority(row, input, stored.index);
  return row;
};

const requireRefundAmount = (
  row: Pick<RefundAuthorityRow, "captured" | "refunded">,
  refunded: Money,
): void => {
  if (
    refunded.currency !== row.captured.currency ||
    refunded.amount < row.refunded.amount ||
    refunded.amount > row.captured.amount
  ) {
    throw new Error(
      "Refund observation currency changed or amount moved backwards or grew too far",
    );
  }
};

const changeRefundAuthorityStatement = (
  row: RefundAuthorityVersion,
  state: RefundAuthorityState,
  refunded: Money,
  now: number,
): { readonly args: (string | number | null)[]; readonly sql: string } => {
  requireRefundAmount(row, refunded);
  return {
    args: [
      refunded.amount,
      ...stateWrite(state, row.revision, now),
      row.id,
      row.revision,
    ],
    sql: `UPDATE payment_charges
             SET refunded_amount = ?, refund_state = ?, refund_state_name = ?,
                 refund_local_state = ?, next_refund_action_at = ?,
                 refund_revision = ?, updated_at = ?, observed_at = ?
           WHERE id = ? AND refund_revision = ?
       RETURNING ${AUTHORITY_COLUMNS}`,
  };
};

type RefundTransition = (state: RefundAuthorityState) => RefundAuthorityState;

/** Replace one already-read revision in one database statement. */
export const transitionRefundAuthority = async (
  row: RefundAuthorityVersion,
  now: number,
  refunded: Money,
  transition: RefundTransition,
): Promise<RefundAuthorityRow | null> => {
  const statement = changeRefundAuthorityStatement(
    row,
    transition(row.state),
    refunded,
    now,
  );
  return authorityFromResult(await execute(statement.sql, statement.args));
};

/** Persist provider completion for the exact authority revision. */
export const completeRefundAuthority = async (
  row: RefundAuthorityVersion,
  refunded: Money,
  now: number,
  proof: "owner" | "provider",
): Promise<RefundAuthorityRow | null> => {
  const state = markRefundCompleted(row.state, now, proof);
  const authority = changeRefundAuthorityStatement(row, state, refunded, now);
  return authorityFromResult(await execute(authority.sql, authority.args));
};

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
