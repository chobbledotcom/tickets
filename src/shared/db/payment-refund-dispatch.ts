/** Atomically cross the last durable boundary before provider refund calls. */

/* jscpd:ignore-start -- imports */
import { unique } from "#fp";
import {
  inPlaceholders,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  type PaymentRowRecord,
  paymentRowHeldBy,
  paymentRowStateStatement,
  readPaymentClaimRows,
} from "#shared/db/payment-claim.ts";
import {
  completeExactReferenceRows,
  distinctHeldPaymentRows,
  type HeldRefundCommand,
  type IndexedRefundClaimDecision,
  type RefundClaimChanged,
} from "#shared/payment/claim.ts";
import type {
  RefundClaim,
  RefundClaimPhase,
  RefundProviderCapability,
} from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

export type RefundDispatchPermit = {
  readonly capability: RefundProviderCapability;
  readonly commandId: string;
  readonly index: string;
  readonly kind: "refund_dispatch";
};

export interface ArmRefundDispatchRequest extends HeldRefundCommand {
  readonly indexes: readonly string[];
}

interface KeylessOwnerReview
  extends IndexedRefundClaimDecision<"owner_review"> {
  readonly reason: "uncertain_keyless_refund";
}

export type ArmRefundDispatchResult =
  | RefundClaimChanged
  | KeylessOwnerReview
  | {
      readonly kind: "armed";
      readonly permits: ReadonlyMap<string, RefundDispatchPermit>;
      readonly phases: ReadonlyMap<string, RefundClaimPhase>;
    };

type ReadyRow = {
  readonly claim: Extract<RefundClaim, { phase: "ready" | "send_armed" }>;
  readonly index: string;
  readonly record: PaymentRowRecord;
};

const canDispatch = (claim: RefundClaim): claim is ReadyRow["claim"] =>
  claim.phase === "ready" || claim.phase === "send_armed";

const distinctIndexes = (indexes: readonly string[]): string[] => {
  const distinct = unique([...indexes]);
  if (distinct.length !== indexes.length || distinct.some((index) => !index)) {
    throw new Error("Refund dispatch indexes must be distinct and non-empty");
  }
  return distinct;
};

const checkedRows = async (
  request: ArmRefundDispatchRequest,
  indexes: readonly string[],
  tx: TxScope,
): Promise<ReadyRow[] | null> => {
  const heldRows = distinctHeldPaymentRows(request.held);
  const heldBySession = new Map(
    heldRows.map((row) => [row.sessionId, row.attendeeId]),
  );
  const stored = await readPaymentClaimRows(
    tx,
    `payment_reference_index IN (${inPlaceholders(indexes)})`,
    [...indexes],
  );
  const rows = await Promise.all(
    stored.map(async (row): Promise<ReadyRow | null> => {
      const attendeeId = heldBySession.get(row.payment_session_id);
      if (attendeeId === undefined || attendeeId !== Number(row.attendee_id)) {
        return null;
      }
      const exact = await paymentRowHeldBy(row, request);
      if (exact === null || !canDispatch(exact.claim)) return null;
      return {
        claim: exact.claim,
        index: row.payment_reference_index,
        record: exact.record,
      };
    }),
  );
  return completeExactReferenceRows(rows, indexes);
};

const capabilityByIndex = (
  rows: readonly ReadyRow[],
): ReadonlyMap<string, RefundProviderCapability> =>
  new Map(
    [...Map.groupBy(rows, ({ index }) => index)].map(([index, matches]) => {
      const capabilities = unique(matches.map(({ claim }) => claim.capability));
      if (capabilities.length !== 1) {
        throw new Error(`Payment ${index} has conflicting refund capabilities`);
      }
      return [index, capabilities[0]!] as const;
    }),
  );

const uncertainKeylessIndexes = (rows: readonly ReadyRow[]): string[] =>
  unique(
    rows.flatMap(({ claim, index }) =>
      claim.phase === "send_armed" && claim.capability === "keyless"
        ? [index]
        : [],
    ),
  );

/** Arm every requested reference or none, then return the only objects the
 *  admin refund path accepts as permission to call a provider. */
export const armRefundDispatch = async (
  request: ArmRefundDispatchRequest,
): Promise<ArmRefundDispatchResult> => {
  const indexes = distinctIndexes(request.indexes);
  if (indexes.length === 0) {
    return { kind: "armed", permits: new Map(), phases: new Map() };
  }
  return await withTransaction(async (tx) => {
    const rows = await checkedRows(request, indexes, tx);
    if (rows === null) return { kind: "claim_changed" };
    const uncertain = uncertainKeylessIndexes(rows);
    if (uncertain.length > 0) {
      return {
        indexes: uncertain,
        kind: "owner_review",
        reason: "uncertain_keyless_refund",
      };
    }
    const writes = await Promise.all(
      rows.flatMap(({ claim, record }) =>
        claim.phase === "send_armed"
          ? []
          : [
              paymentRowStateStatement(record, {
                ...record.state,
                claim: { ...claim, phase: "send_armed" },
              }),
            ],
      ),
    );
    const results = writes.length === 0 ? [] : await tx.batch(writes);
    if (results.some(({ rowsAffected }) => rowsAffected !== 1)) {
      throw new Error("Refund dispatch could not arm every payment row");
    }
    const capabilities = capabilityByIndex(rows);
    return {
      kind: "armed",
      permits: new Map(
        [...capabilities].map(([index, capability]) => [
          index,
          {
            capability,
            commandId: request.commandId,
            index,
            kind: "refund_dispatch",
          },
        ]),
      ),
      phases: new Map(
        rows.map(({ record }) => [record.sessionId, "send_armed"]),
      ),
    };
  });
};
