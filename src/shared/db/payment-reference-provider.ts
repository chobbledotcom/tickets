/** Atomically bind provider evidence to the payment rows a refund run holds. */

import { compact, unique } from "#fp";
import {
  inPlaceholders,
  type SqlStatement,
  withTransaction,
} from "#shared/db/client.ts";
import {
  asPaymentRowRecord,
  type PaymentRowRecord,
  paymentRowStateStatement,
  readPaymentClaimRows,
  type StoredPaymentClaimRow,
} from "#shared/db/payment-claim.ts";
import {
  paymentReferenceIndex,
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import { type HeldPaymentRow, heldPaymentRows } from "#shared/payment/claim.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type {
  RefundClaim,
  ResolvedRefundCapability,
} from "#shared/payment/row-state.ts";

/** The exact claim snapshot and validated provider identities being stored. */
export type PaymentReferenceProviderBindingRequest = {
  /** Every held reference uses the safest capability among its providers. */
  readonly capability: ResolvedRefundCapability;
  /** Current blind index to the provider identity proved for that reference. */
  readonly bindings: ReadonlyMap<string, TaggedPaymentReference>;
  readonly held: ReadonlyMap<number, readonly string[]>;
  readonly heldSince: string;
};

/** Expected refusals write nothing; success names every resulting identity. */
export type PaymentReferenceProviderBindingResult =
  | { readonly kind: "claim_changed" }
  | {
      readonly indexes: readonly string[];
      readonly kind: "historical_marker";
    }
  | {
      readonly indexes: ReadonlyMap<string, string>;
      readonly kind: "bound";
    };

type PreparedBinding = {
  newIndex: string;
  oldIndex: string;
  stored: StoredPaymentReference;
};

type CheckedHeldRow = {
  claim: RefundClaim;
  index: string;
  record: PaymentRowRecord;
};

const requireDistinctHeldSessions = (
  sessions: readonly HeldPaymentRow[],
): void => {
  if (
    new Set(sessions.map(({ sessionId }) => sessionId)).size !== sessions.length
  ) {
    throw new Error(
      "A payment reference provider binding repeated a held session",
    );
  }
};

const prepareBindings = (
  bindings: ReadonlyMap<string, TaggedPaymentReference>,
): Promise<PreparedBinding[]> =>
  Promise.all(
    [...bindings].map(async ([oldIndex, reference]) => {
      const stored = await storePaymentReference(reference);
      const untaggedIndex = await paymentReferenceIndex({
        kind: "untagged",
        reference: reference.reference,
      });
      if (oldIndex !== stored.index && oldIndex !== untaggedIndex) {
        throw new Error(
          `Payment reference binding ${oldIndex} does not match ${reference.reference}`,
        );
      }
      return { newIndex: stored.index, oldIndex, stored };
    }),
  );

const rowsForBinding = (
  sessionIds: readonly string[],
  oldIndexes: readonly string[],
): { args: string[]; where: string } => ({
  args: [...sessionIds, ...oldIndexes],
  where:
    `payment_session_id IN (${inPlaceholders(sessionIds)})` +
    (oldIndexes.length === 0
      ? ""
      : ` OR payment_reference_index IN (${inPlaceholders(oldIndexes)})`),
});

const checkedHeldRows = async (
  rows: readonly StoredPaymentClaimRow[],
  sessions: readonly HeldPaymentRow[],
  bindings: ReadonlyMap<string, TaggedPaymentReference>,
  heldSince: string,
): Promise<CheckedHeldRow[] | null> => {
  const bySession = new Map(rows.map((row) => [row.payment_session_id, row]));
  const checked = await Promise.all(
    sessions.map(async ({ attendeeId, sessionId }) => {
      const row = bySession.get(sessionId);
      if (row === undefined || Number(row.attendee_id) !== attendeeId) {
        return null;
      }
      if (!bindings.has(row.payment_reference_index)) return null;
      const record = await asPaymentRowRecord(row);
      const claim = record.state.claim;
      return claim !== undefined &&
        claim.attendeeId === attendeeId &&
        claim.scope === "attendee_set" &&
        claim.writtenAt === heldSince
        ? { claim, index: row.payment_reference_index, record }
        : null;
    }),
  );
  const complete = compact(checked);
  if (complete.length !== checked.length) return null;
  const heldIndexes = new Set(complete.map(({ index }) => index));
  return heldIndexes.size === bindings.size &&
    [...bindings.keys()].every((index) => heldIndexes.has(index))
    ? complete
    : null;
};

const markedChangingIndexes = (
  rows: readonly StoredPaymentClaimRow[],
  bindings: readonly PreparedBinding[],
): string[] =>
  bindings
    .filter(({ newIndex, oldIndex }) => newIndex !== oldIndex)
    .filter(({ oldIndex }) =>
      rows.some(
        (row) =>
          row.payment_reference_index === oldIndex &&
          row.provider_refunded_at !== "",
      ),
    )
    .map(({ oldIndex }) => oldIndex);

const referenceRewrite = ({
  newIndex,
  oldIndex,
  stored,
}: PreparedBinding): SqlStatement => ({
  args: [stored.encrypted, newIndex, oldIndex],
  sql: `UPDATE processed_payments
           SET payment_reference = ?, payment_reference_index = ?
         WHERE payment_reference_index = ?`,
});

const claimCapabilityRewrite = (
  row: CheckedHeldRow,
  capability: ResolvedRefundCapability,
): Promise<SqlStatement> =>
  paymentRowStateStatement(row.record, {
    ...row.record.state,
    claim: { ...row.claim, capability },
  });

const boundIndexes = (
  bindings: readonly PreparedBinding[],
): ReadonlyMap<string, string> =>
  new Map(bindings.map(({ newIndex, oldIndex }) => [oldIndex, newIndex]));

/**
 * Store already-validated provider identities without doing provider I/O.
 * The exact claim check, historical-marker refusal, shared-row rewrite, and
 * claim capability change all share one write transaction.
 */
export const bindPaymentReferenceProviders = async (
  request: PaymentReferenceProviderBindingRequest,
): Promise<PaymentReferenceProviderBindingResult> => {
  const sessions = heldPaymentRows(request.held);
  requireDistinctHeldSessions(sessions);
  const prepared = await prepareBindings(request.bindings);
  if (sessions.length === 0) {
    return prepared.length === 0
      ? { indexes: new Map(), kind: "bound" }
      : { kind: "claim_changed" };
  }
  return await withTransaction(async (tx) => {
    const query = rowsForBinding(
      sessions.map(({ sessionId }) => sessionId),
      prepared.map(({ oldIndex }) => oldIndex),
    );
    const rows = await readPaymentClaimRows(tx, query.where, query.args);
    const heldRows = await checkedHeldRows(
      rows,
      sessions,
      request.bindings,
      request.heldSince,
    );
    if (heldRows === null) return { kind: "claim_changed" };
    const historical = unique(markedChangingIndexes(rows, prepared));
    if (historical.length > 0) {
      return { indexes: historical, kind: "historical_marker" };
    }
    const referenceWrites = prepared
      .filter(({ newIndex, oldIndex }) => newIndex !== oldIndex)
      .map(referenceRewrite);
    const claimWrites = await Promise.all(
      heldRows.map((row) => claimCapabilityRewrite(row, request.capability)),
    );
    await tx.batch([...referenceWrites, ...claimWrites]);
    return { indexes: boundIndexes(prepared), kind: "bound" };
  });
};
