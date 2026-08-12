/** Atomically bind provider evidence to the payment rows a refund run holds. */

/* jscpd:ignore-start -- imports */
import { requiredMapValue, unique } from "#fp";
import {
  inPlaceholders,
  type SqlStatement,
  withTransaction,
} from "#shared/db/client.ts";
import {
  type PaymentRowRecord,
  paymentRowHeldBy,
  paymentRowStateStatement,
  readPaymentClaimRows,
  type StoredPaymentClaimRow,
} from "#shared/db/payment-claim.ts";
import {
  paymentReferenceIndex,
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import {
  completeExactReferenceRows,
  distinctHeldPaymentRows,
  type HeldPaymentRow,
  type HeldRefundCommand,
  type IndexedRefundClaimDecision,
  type RefundClaimChanged,
} from "#shared/payment/claim.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type {
  RefundClaim,
  RefundProviderCapability,
} from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

/** One reference's validated provider identity and retry capability. */
export type PaymentReferenceProviderBinding = {
  readonly capability: RefundProviderCapability;
  readonly identity: TaggedPaymentReference;
};

/** The exact claim snapshot and validated provider facts being stored. */
export interface PaymentReferenceProviderBindingRequest
  extends HeldRefundCommand {
  /** Current blind index to the provider facts proved for that reference. */
  readonly bindings: ReadonlyMap<string, PaymentReferenceProviderBinding>;
}

/** Expected refusals write nothing; success names every resulting identity. */
export type PaymentReferenceProviderBindingResult =
  | RefundClaimChanged
  | IndexedRefundClaimDecision<"historical_marker">
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

const prepareBindings = (
  bindings: ReadonlyMap<string, PaymentReferenceProviderBinding>,
): Promise<PreparedBinding[]> =>
  Promise.all(
    [...bindings].map(async ([oldIndex, { identity }]) => {
      const stored = await storePaymentReference(identity);
      const untaggedIndex = await paymentReferenceIndex({
        kind: "untagged",
        reference: identity.reference,
      });
      if (oldIndex !== stored.index && oldIndex !== untaggedIndex) {
        throw new Error(
          `Payment reference binding ${oldIndex} does not match ${identity.reference}`,
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
  bindings: ReadonlyMap<string, PaymentReferenceProviderBinding>,
  commandId: string,
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
      const held = await paymentRowHeldBy(row, { commandId, heldSince });
      if (
        held === null ||
        (held.claim.phase !== "checking" && held.claim.phase !== "send_armed")
      )
        return null;
      return { ...held, index: row.payment_reference_index };
    }),
  );
  return completeExactReferenceRows(checked, [...bindings.keys()]);
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
  bindings: ReadonlyMap<string, PaymentReferenceProviderBinding>,
): Promise<SqlStatement> => {
  const capability = requiredMapValue(
    bindings,
    row.index,
    `Provider binding lost payment reference ${row.index}`,
  ).capability;
  if (row.claim.phase === "send_armed" && row.claim.capability !== capability) {
    throw new Error(
      `Provider capability changed for armed payment ${row.index}`,
    );
  }
  return paymentRowStateStatement(row.record, {
    ...row.record.state,
    claim:
      row.claim.phase === "send_armed"
        ? row.claim
        : { ...row.claim, capability, phase: "ready" },
  });
};

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
  const sessions = distinctHeldPaymentRows(request.held);
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
      request.commandId,
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
      heldRows.map((row) => claimCapabilityRewrite(row, request.bindings)),
    );
    await tx.batch([...referenceWrites, ...claimWrites]);
    return {
      indexes: boundIndexes(prepared),
      kind: "bound",
    };
  });
};
