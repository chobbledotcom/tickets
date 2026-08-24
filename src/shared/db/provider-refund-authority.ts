/** Atomic storage for the one provider-refund authority. */

/* jscpd:ignore-start -- imports */
import {
  execute,
  queryAll,
  queryOne,
  resultRows,
  type SqlStatement,
} from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { storePaymentReference } from "#db/payment-reference-store.ts";
import { type Money, sameMoney } from "#payment/money.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import {
  type RefundAuthorityState,
  readRefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#payment/refund-authority-state.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#payment/refund-provider-authorization.ts";
import { requireValue } from "#shared/required-value.ts";
import type { PaymentProviderType } from "#types";
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

export const REFUND_AUTHORITY_COLUMNS = `id, provider, reference_index,
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
): RefundAuthorityRow | null =>
  rows[0] === undefined ? null : authorityRow(rows[0]);

export const refundAuthorityFromResult = (
  result: Parameters<typeof resultRows>[0],
): RefundAuthorityRow | null =>
  oneAuthority(resultRows<StoredRefundAuthorityRow>(result));

const loadRefundAuthority = async (
  field: "id" | "reference_index",
  value: number | string,
): Promise<RefundAuthorityRow | null> => {
  const row = await queryOne<StoredRefundAuthorityRow>(
    `SELECT ${REFUND_AUTHORITY_COLUMNS}
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
    `SELECT ${REFUND_AUTHORITY_COLUMNS}
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
  const statement = numberedStatement((bind) => {
    const callback = bind(callbackReplayIndex);
    const reference = bind(referenceIndex);
    return `UPDATE payment_charges
          SET callback_replay_index = COALESCE(callback_replay_index, ${callback})
        WHERE reference_index = ${reference}
          AND callback_replay_index IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM payment_charges AS callbackOwner
             WHERE callbackOwner.callback_replay_index = ${callback}
               AND callbackOwner.reference_index <> ${reference}
          )
      RETURNING ${REFUND_AUTHORITY_COLUMNS}`;
  });
  const changed = refundAuthorityFromResult(
    await execute(statement.sql, statement.args),
  );
  if (changed !== null) return changed;
  return await loadRefundCallbackBinding(binding);
};

export interface CreateRefundAuthority {
  readonly callbackReplayIndex?: string | undefined;
  readonly captured: Money;
  readonly now: number;
  readonly reference: TaggedPaymentReference;
  readonly state: Extract<RefundAuthorityState, { kind: "ready" }>;
}

export interface PreparedRefundAuthority {
  readonly requireResult: (
    result: Parameters<typeof resultRows>[0],
  ) => RefundAuthorityRow;
  readonly statement: SqlStatement;
}

const requireCreateFacts = (input: CreateRefundAuthority): void => {
  if (
    REFUND_PROVIDER_CAPABILITIES[input.reference.provider] !==
    input.state.request.capability
  ) {
    throw new Error("Refund authority facts disagree");
  }
};

const requireSameAuthority = (
  row: RefundAuthorityRow,
  input: CreateRefundAuthority,
): void => {
  if (!sameMoney(row.captured, input.captured)) {
    throw new Error("Refund identity belongs to different charge facts");
  }
};

const requireAuthority = (
  row: RefundAuthorityRow | null,
  input: CreateRefundAuthority,
): RefundAuthorityRow => {
  const authority = requireValue(row, "Created refund authority is missing");
  requireSameAuthority(authority, input);
  return authority;
};

interface PreparedRefundAuthorityWrite {
  readonly loadConflictOwner: () => Promise<RefundAuthorityRow | null>;
  readonly prepared: PreparedRefundAuthority;
}

const prepareRefundAuthorityWrite = async (
  input: CreateRefundAuthority,
): Promise<PreparedRefundAuthorityWrite> => {
  requireCreateFacts(input);
  const stored = await storePaymentReference(input.reference);
  const callbackReplayIndex = input.callbackReplayIndex;
  const statement: SqlStatement = numberedStatement((bind) => {
    const now = bind(input.now);
    return `INSERT INTO payment_charges
        (provider, provider_reference, reference_index, callback_replay_index,
         capability, captured_amount, currency, refunded_amount, refund_state,
          refund_state_name, refund_local_state, next_refund_action_at,
          refund_revision, created_at, updated_at, observed_at)
         VALUES (${bind(input.reference.provider)}, ${bind(stored.encrypted)}, ${bind(stored.index)},
                 ${bind(input.callbackReplayIndex === undefined ? null : input.callbackReplayIndex)},
                 ${bind(input.state.request.capability)}, ${bind(input.captured.amount)},
                 ${bind(input.captured.currency)}, ${bind(0)},
                 ${bind(writeRefundAuthorityState(input.state))},
                 ${bind(refundStateMirror(input.state))},
                 ${bind(refundLocalMirror(input.state))},
                 ${bind(refundNextActionAt(input.state))}, ${bind(1)},
                 ${now}, ${now}, ${now})
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
        RETURNING ${REFUND_AUTHORITY_COLUMNS}`;
  });
  return {
    loadConflictOwner:
      callbackReplayIndex === undefined
        ? () => loadRefundAuthorityByReference(stored.index)
        : () =>
            loadRefundCallbackBinding({
              callbackReplayIndex,
              referenceIndex: stored.index,
            }),
    prepared: {
      requireResult: (result) =>
        requireAuthority(refundAuthorityFromResult(result), input),
      statement,
    },
  };
};

/** Prepare the exact authority upsert for a caller-owned transaction. */
export const prepareRefundAuthority = async (
  input: CreateRefundAuthority,
): Promise<PreparedRefundAuthority> =>
  (await prepareRefundAuthorityWrite(input)).prepared;

/** Create the charge authority once, then return the row owning its identity. */
export const createOrLoadRefundAuthority = async (
  input: CreateRefundAuthority,
): Promise<RefundAuthorityRow> => {
  const { loadConflictOwner, prepared } =
    await prepareRefundAuthorityWrite(input);
  const result = await execute(prepared.statement.sql, prepared.statement.args);
  const returned = refundAuthorityFromResult(result);
  return returned === null
    ? requireAuthority(await loadConflictOwner(), input)
    : prepared.requireResult(result);
};
