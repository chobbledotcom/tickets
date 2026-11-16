/** Atomic storage for the one provider-refund authority. */

import type { ResultSet } from "@libsql/client";
import { execute, queryAll, queryOne, resultRows } from "#db/client.ts";
import { storePaymentReference } from "#db/payment-reference-store.ts";
import {
  and,
  type Expr,
  equal,
  not,
  notEqual,
  type Operand,
  or,
  valued,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlName, sqlNames } from "#db/sql.ts";
import { insertInto, update } from "#db/write.ts";
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
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { requireValue } from "#shared/required-value.ts";
import type { PaymentProviderType } from "#types";

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

/** The columns of one refund authority that a read or a write gives back. */
export const REFUND_AUTHORITY_COLUMN_NAMES = [
  "id",
  "provider",
  "reference_index",
  "callback_replay_index",
  "captured_amount",
  "currency",
  "refunded_amount",
  "refund_state",
  "refund_revision",
] as const;

const REFUND_AUTHORITY_COLUMNS = sqlNames(REFUND_AUTHORITY_COLUMN_NAMES);

/** No other charge holds the callback identity. */
const noOtherCallbackOwner = (
  callbackReplayIndex: Operand<string | null>,
  referenceIndex: Operand<string>,
): Expr<boolean> =>
  not(
    from(tables.payment_charges)
      .as("callbackOwner")
      .where((owner) => [
        equal(owner.callback_replay_index, callbackReplayIndex),
        notEqual(owner.reference_index, referenceIndex),
      ])
      .exists(),
  );

/** The stored callback identity, or `fallback` where none is stored. */
const callbackOrElse = (
  charge: Node<"payment_charges">,
  fallback: Operand<string | null>,
): Expr<string | null> =>
  valued(sql`COALESCE(${charge.callback_replay_index}, ${fallback})`);

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
  result: ResultSet,
): RefundAuthorityRow | null =>
  oneAuthority(resultRows<StoredRefundAuthorityRow>(result));

const loadRefundAuthority = async (
  field: "id" | "reference_index",
  value: number | string,
): Promise<RefundAuthorityRow | null> => {
  const row = await queryOne<StoredRefundAuthorityRow>(
    sql`SELECT ${REFUND_AUTHORITY_COLUMNS}
       FROM payment_charges
      WHERE ${sqlName(field)} = ${value}`,
  );
  return row === null ? null : authorityRow(row);
};

/** The value each payment-charge identity takes. */
type AuthorityKey = { id: number; reference_index: string };

/** Load one charge through one identity, with that identity fixed now. */
const loadRefundAuthorityBy =
  <Field extends keyof AuthorityKey>(field: Field) =>
  (value: AuthorityKey[Field]): Promise<RefundAuthorityRow | null> =>
    loadRefundAuthority(field, value);

/** Load one charge through its globally unique blind identity. */
export const loadRefundAuthorityByReference =
  loadRefundAuthorityBy("reference_index");

/** Load one charge through its local row id. */
export const loadRefundAuthorityById = loadRefundAuthorityBy("id");

interface RefundCallbackBinding {
  readonly callbackReplayIndex: string;
  readonly referenceIndex: string;
}

const loadRefundCallbackBinding = async ({
  callbackReplayIndex,
  referenceIndex,
}: RefundCallbackBinding): Promise<RefundAuthorityRow | null> => {
  const owners = await queryAll<StoredRefundAuthorityRow>(
    sql`SELECT ${REFUND_AUTHORITY_COLUMNS}
       FROM payment_charges
      WHERE reference_index = ${referenceIndex} OR callback_replay_index = ${callbackReplayIndex}`,
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
  const statement = update(tables.payment_charges, (charge) => ({
    callback_replay_index: callbackOrElse(charge, callbackReplayIndex),
  }))
    .where((charge) => [
      equal(charge.reference_index, referenceIndex),
      equal(charge.callback_replay_index, null),
      noOtherCallbackOwner(callbackReplayIndex, referenceIndex),
    ])
    .returning(...REFUND_AUTHORITY_COLUMN_NAMES);
  const changed = refundAuthorityFromResult(await execute(statement));
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
    PAYMENT_PROVIDERS[input.reference.provider].refundCapability !==
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
  const statement = insertInto(
    tables.payment_charges,
    {
      callback_replay_index:
        input.callbackReplayIndex === undefined
          ? null
          : input.callbackReplayIndex,
      capability: input.state.request.capability,
      captured_amount: input.captured.amount,
      created_at: input.now,
      currency: input.captured.currency,
      next_refund_action_at: refundNextActionAt(input.state),
      observed_at: input.now,
      provider: input.reference.provider,
      provider_reference: stored.encrypted,
      reference_index: stored.index,
      refund_local_state: refundLocalMirror(input.state),
      refund_revision: 1,
      refund_state: writeRefundAuthorityState(input.state),
      refund_state_name: refundStateMirror(input.state),
      refunded_amount: 0,
      updated_at: input.now,
    },
    {
      onConflict: {
        set: (row, excluded) => ({
          callback_replay_index: callbackOrElse(
            row,
            excluded.callback_replay_index,
          ),
        }),
        where: (row, excluded) =>
          and(
            equal(row.reference_index, excluded.reference_index),
            or(
              equal(excluded.callback_replay_index, null),
              equal(row.callback_replay_index, null),
              equal(row.callback_replay_index, excluded.callback_replay_index),
            ),
            noOtherCallbackOwner(
              excluded.callback_replay_index,
              excluded.reference_index,
            ),
          ),
      },
    },
  ).returning(...REFUND_AUTHORITY_COLUMN_NAMES);
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
  const result = await execute(prepared.statement);
  const returned = refundAuthorityFromResult(result);
  return returned === null
    ? requireAuthority(await loadConflictOwner(), input)
    : prepared.requireResult(result);
};
