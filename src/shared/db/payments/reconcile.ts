import { uniqueBy } from "#fp";
import {
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  paymentCaseResolutionStatement,
  paymentCaseStatement,
  readPaymentCaseRow,
  type StoredPaymentCaseRow,
} from "#shared/db/payments/cases.ts";
import { paymentChargeStatements } from "#shared/db/payments/charges.ts";
import {
  advancePaymentSessionClaim,
  type PaymentSessionClaim,
  paymentSessionClaimStatement,
} from "#shared/db/payments/claims.ts";
import {
  readPaymentSessionRow,
  type StoredPaymentSessionRow,
} from "#shared/db/payments/session-record.ts";
import type {
  PaymentCase,
  PaymentSession,
  PaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import {
  type ProviderRead,
  paymentObservationResources,
} from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";

export type StoredPaymentReconciliation = {
  claim: PaymentSessionClaim | null;
  payment: PaymentSession;
  retryStopped: boolean;
};

const caseForResolution = (
  payment: PaymentSession,
  read: ProviderRead,
  resolution: PaymentResolution,
  observedAt: number,
): Promise<SqlStatement | null> => {
  if (resolution.status !== "conflict" && resolution.status !== "retry") {
    return Promise.resolve(null);
  }
  return paymentCaseStatement(
    {
      evidence: { kind: "provider_read", read },
      nextReconcileAt:
        resolution.status === "retry" ? observedAt + 60_000 : null,
      paymentId: payment.id,
      reason:
        resolution.status === "retry"
          ? resolution.reason
          : resolution.issue.kind,
      resource: resolution.resource,
      state: resolution.status === "retry" ? "retrying" : "needs_action",
    },
    observedAt,
  );
};

const resourceKey = (resource: ProviderResource): string =>
  `${resource.provider}:${resource.kind}:${resource.id}:${
    "parentId" in resource ? resource.parentId : ""
  }`;

const observedResources = (read: ProviderRead): ProviderResource[] => {
  if (read.status !== "found") return [];
  return uniqueBy(resourceKey)([
    read.returned,
    ...paymentObservationResources(read.observation),
  ]);
};

const resolutionStatements = async (
  paymentId: string,
  read: ProviderRead,
  observedAt: number,
): Promise<SqlStatement[]> =>
  Promise.all(
    observedResources(read).map((resource) =>
      paymentCaseResolutionStatement(paymentId, resource, observedAt),
    ),
  );

const executeStatements = async (
  tx: TxScope,
  statements: readonly SqlStatement[],
): Promise<void> => {
  if (statements.length > 0) await tx.batch([...statements]);
};

const requireReturnedRow = <Row>(rows: Row[], message: string): Row => {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw new Error(message);
  return row;
};

const readRecordedCase = async (
  tx: TxScope,
  statement: SqlStatement | null,
  paymentId: string,
): Promise<PaymentCase | null> => {
  if (statement === null) return null;
  const row = requireReturnedRow(
    resultRows<StoredPaymentCaseRow>(await tx.execute(statement)),
    `Payment case for ${paymentId} was not recorded`,
  );
  return readPaymentCaseRow(row);
};

/** Persist provider facts, their case outcome, and aggregate state atomically. */
export const storePaymentReconciliation = async (
  claim: PaymentSessionClaim,
  payment: PaymentSession,
  read: ProviderRead,
  resolution: PaymentResolution,
  progress: PaymentSessionProgress,
  retainLease: boolean,
  observedAt = Date.now(),
): Promise<StoredPaymentReconciliation> => {
  const charges =
    read.status === "found" && read.observation.charges !== undefined
      ? await paymentChargeStatements(
          payment.id,
          read.observation.session,
          read.observation.charges,
          observedAt,
        )
      : [];
  const openCase = await caseForResolution(
    payment,
    read,
    resolution,
    observedAt,
  );
  const closeCases = await resolutionStatements(payment.id, read, observedAt);
  const stored = await withTransaction(async (tx) => {
    await executeStatements(tx, [...charges, ...closeCases]);
    const paymentCase = await readRecordedCase(tx, openCase, payment.id);
    const retryStopped =
      resolution.status === "retry" && paymentCase?.state === "needs_action";
    const storedProgress: PaymentSessionProgress = retryStopped
      ? { ...progress, nextReconcileAt: null, state: "needs_action" }
      : progress;
    const update = await paymentSessionClaimStatement(!retainLease)(
      claim,
      storedProgress,
    );
    const result = await tx.execute(update);
    const row = requireReturnedRow(
      resultRows<StoredPaymentSessionRow>(result),
      `Lost payment session lease for ${claim.paymentId}`,
    );
    return { progress: storedProgress, retryStopped, row };
  });
  return {
    claim: retainLease
      ? advancePaymentSessionClaim(claim, stored.progress.state)
      : null,
    payment: await readPaymentSessionRow(stored.row),
    retryStopped: stored.retryStopped,
  };
};
