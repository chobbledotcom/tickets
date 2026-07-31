import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import {
  claimPaymentSession,
  type PaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import {
  type StoredPaymentReconciliation,
  storePaymentReconciliation,
} from "#shared/db/payments/reconcile.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  type PaymentForFoundRead,
  paymentForFoundRead,
} from "#shared/payment-runtime/adopt.ts";
import {
  isTerminalLegacyPayment,
  legacyPaymentResult,
} from "#shared/payment-runtime/legacy-replay.ts";
import {
  type LocatedPayment,
  locatePayment,
  type PaymentLocator,
} from "#shared/payment-runtime/locate.ts";
import { paymentProgressForResolution } from "#shared/payment-runtime/progress.ts";
import {
  invalidProviderReadFor,
  readProviderOrInvalid,
} from "#shared/payment-runtime/provider-read.ts";
import {
  currentPaymentCharges,
  type PaymentRefundOutcome,
  refundCharges,
} from "#shared/payment-runtime/refund.ts";
import { terminalPaymentOutcome } from "#shared/payment-runtime/terminal.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import { resolvePayment } from "#shared/payment-state/resolve.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import { getPaymentProvider, type PaymentProvider } from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const PAYMENT_LEASE_MS = 5 * 60 * 1_000;

interface PaymentOutcome<Payment, Status extends string> {
  payment: Payment;
  status: Status;
}

type LegacyResultOutcome<
  Result extends PaymentResult,
  Status extends "completed" | "fulfilled",
> = PaymentOutcome<LegacyPaymentReplay, Status> & {
  replayed: true;
  result: Result;
};

type StoredOutcomeStatus = Exclude<PaymentResolution["status"], "ready">;

export type PaymentReconcileOutcome =
  | (PaymentOutcome<PaymentSession, "completed"> & { replayed: boolean })
  | LegacyResultOutcome<Extract<PaymentResult, { success: true }>, "completed">
  | LegacyResultOutcome<Extract<PaymentResult, { success: false }>, "fulfilled">
  | PaymentOutcome<LegacyPaymentReplay, "conflict">
  | PaymentOutcome<PaymentSession, StoredOutcomeStatus>
  | PaymentOutcome<PaymentSession, "busy">
  | PaymentOutcome<null, "busy" | "conflict" | "ignore" | "retry">
  | (PaymentOutcome<PaymentSession, "fulfilled"> & {
      result: PaymentResult;
    });

export type FulfilPayment = (work: PaymentWork) => Promise<PaymentResult>;
export type PaymentReconcileMode = "callback" | "maintenance";

const paymentOutcome = <Payment, const Status extends string>(
  payment: Payment,
  status: Status,
): PaymentOutcome<Payment, Status> => ({ payment, status });

const outcomeResult = (
  outcome: PaymentReconcileOutcome,
): { outcome: PaymentReconcileOutcome } => ({ outcome });

const legacyReplayOutcome = async (
  payment: LegacyPaymentReplay,
): Promise<PaymentReconcileOutcome | null> => {
  if (!isTerminalLegacyPayment(payment)) return null;
  const result = await legacyPaymentResult(payment);
  return result.success
    ? { ...paymentOutcome(payment, "completed"), replayed: true, result }
    : { ...paymentOutcome(payment, "fulfilled"), replayed: true, result };
};

type PaymentLookupStop = { conflict: true } | { legacy: LegacyPaymentReplay };

const paymentLookupStop = (
  conflict: boolean,
  legacy: LegacyPaymentReplay | null,
): PaymentLookupStop | null =>
  conflict ? { conflict: true } : legacy === null ? null : { legacy };

const lookupStopResult = async (
  stop: PaymentLookupStop,
): Promise<{ outcome: PaymentReconcileOutcome }> =>
  outcomeResult(
    "conflict" in stop
      ? paymentOutcome(null, "conflict")
      : ((await legacyReplayOutcome(stop.legacy)) ??
          paymentOutcome(stop.legacy, "conflict")),
  );

const REFUND_OUTCOME_STATUS: Record<
  PaymentRefundOutcome["status"],
  StoredOutcomeStatus
> = {
  completed: "fully_refunded",
  failed: "retry",
  partial: "conflict",
  pending: "pending",
};

const outcomeForStoredResolution = (
  stored: StoredPaymentReconciliation,
  resolution: PaymentResolution,
): PaymentReconcileOutcome => {
  if (resolution.status === "ready") {
    throw new Error("Ready payment requires fulfilment");
  }
  return paymentOutcome(
    stored.payment,
    stored.retryStopped ? "conflict" : resolution.status,
  );
};

type ProviderPaymentContext = {
  payment: PaymentSession;
  provider: PaymentProvider;
  providerType: PaymentProviderType;
  requested: ProviderResource;
};

const readProviderPayment = async (
  context: ProviderPaymentContext,
  initialRead: ProviderRead | null,
): Promise<ProviderRead> => {
  if (initialRead !== null) return initialRead;
  return readProviderOrInvalid(context.payment, context.requested, async () => {
    const account = await resolvePaymentAccount(context.providerType);
    return account.accountId === context.payment.accountId
      ? await context.provider.readPayment(context.payment, context.requested)
      : invalidProviderReadFor(context, "mismatched_account");
  });
};

const retryRefund = async (
  payment: PaymentSession,
  claim: PaymentSessionClaim,
): Promise<PaymentReconcileOutcome> => {
  const charges = await getPaymentCharges(payment.id);
  const current = currentPaymentCharges(payment, charges);
  const outcome = await refundCharges(payment, current, claim);
  return paymentOutcome(outcome.payment, REFUND_OUTCOME_STATUS[outcome.status]);
};

const runFulfilment = async (
  payment: PaymentSession,
  claim: PaymentSessionClaim,
  resolution: Extract<PaymentResolution, { status: "ready" }>,
  fulfil: FulfilPayment,
): Promise<PaymentReconcileOutcome> => {
  const charge = resolution.observation.charges?.[0];
  if (
    charge === undefined &&
    resolution.observation.status !== "no_payment_required"
  ) {
    throw new Error(`Ready payment ${payment.id} has no charge`);
  }
  const result = await fulfil({
    claim,
    intent: payment.bookingIntent,
    payment,
    resolution,
    session: {
      amountTotal: resolution.observation.providerTotal.amount,
      createdAt: resolution.observation.createdAt,
      id: payment.id,
      paymentReference: charge?.resource.id ?? null,
    },
  });
  return { ...paymentOutcome(payment, "fulfilled"), result };
};

const fulfilStoredCompletion = async (
  payment: PaymentSession,
  claim: PaymentSessionClaim,
  fulfil: FulfilPayment,
): Promise<PaymentReconcileOutcome> => {
  const resolution = payment.result;
  if (resolution?.status !== "ready") {
    throw new Error(`Payment ${payment.id} has no ready completion facts`);
  }
  return runFulfilment(payment, claim, resolution, fulfil);
};

const retainedClaim = (
  stored: StoredPaymentReconciliation,
): PaymentSessionClaim => {
  const claim = stored.claim;
  if (claim === null) {
    throw new Error("Ready payment did not retain its claim");
  }
  return claim;
};

const reconcileClaimedPayment = async (
  context: ProviderPaymentContext,
  claim: PaymentSessionClaim,
  initialRead: ProviderRead | null,
  fulfil: FulfilPayment,
): Promise<PaymentReconcileOutcome> => {
  if (context.payment.completionState === "pending") {
    return fulfilStoredCompletion(context.payment, claim, fulfil);
  }
  if (context.payment.state === "refunding") {
    return retryRefund(context.payment, claim);
  }
  const read = await readProviderPayment(context, initialRead);
  const resolution = resolvePayment(read);
  const observedAt = Date.now();
  const stored = await storePaymentReconciliation(
    claim,
    context.payment,
    read,
    resolution,
    paymentProgressForResolution(context.payment, resolution, observedAt),
    resolution.status === "ready",
    observedAt,
  );
  return resolution.status === "ready"
    ? runFulfilment(stored.payment, retainedClaim(stored), resolution, fulfil)
    : outcomeForStoredResolution(stored, resolution);
};

type UnstagedPaymentRead =
  | PaymentForFoundRead
  | { conflict: true }
  | { legacy: LegacyPaymentReplay }
  | { payment: null; status: "ignore" | "retry" };

const readUnstagedPayment = async (
  provider: PaymentProvider,
  requested: ProviderResource,
): Promise<UnstagedPaymentRead> => {
  const read = await readProviderOrInvalid(null, requested, () =>
    provider.readPayment(null, requested),
  );
  return read.status === "found"
    ? paymentForFoundRead(read)
    : {
        payment: null,
        status: read.status === "unavailable" ? "retry" : "ignore",
      };
};

type LocatedPaymentResult =
  | { outcome: PaymentReconcileOutcome }
  | { payment: PaymentSession | null; requested: ProviderResource };

const continueLocatedPayment = async (
  located: LocatedPayment,
  mode: PaymentReconcileMode,
): Promise<LocatedPaymentResult> => {
  const stopped = paymentLookupStop(located.conflict, located.legacy);
  if (stopped !== null) return lookupStopResult(stopped);
  const terminal =
    located.payment === null
      ? null
      : terminalPaymentOutcome(located.payment, mode);
  if (terminal !== null) return outcomeResult(terminal);
  return located.requested === null
    ? outcomeResult(paymentOutcome(located.payment, "ignore"))
    : { payment: located.payment, requested: located.requested };
};

type PaymentReadyForClaim =
  | { initialRead: ProviderRead | null; payment: PaymentSession }
  | { outcome: PaymentReconcileOutcome };

const paymentReadyForClaim = async (
  provider: PaymentProvider,
  payment: PaymentSession | null,
  requested: ProviderResource,
): Promise<PaymentReadyForClaim> => {
  if (payment !== null) return { initialRead: null, payment };
  const found = await readUnstagedPayment(provider, requested);
  if ("conflict" in found) return lookupStopResult(found);
  if ("legacy" in found) {
    return lookupStopResult({ legacy: found.legacy });
  }
  return found.payment === null
    ? outcomeResult(found)
    : { initialRead: found.read, payment: found.payment };
};

/** Reconcile one webhook or redirect through the durable aggregate. */
export const reconcilePayment = async (
  providerType: PaymentProviderType,
  locator: PaymentLocator,
  fulfil: FulfilPayment,
  mode: PaymentReconcileMode = "callback",
): Promise<PaymentReconcileOutcome> => {
  const located = await continueLocatedPayment(
    await locatePayment(providerType, locator),
    mode,
  );
  if ("outcome" in located) return located.outcome;
  const storedProviderType =
    located.payment?.provider ??
    (locator.kind === "provider" ? locator.resource.provider : providerType);
  const provider = await getPaymentProvider(storedProviderType);
  const ready = await paymentReadyForClaim(
    provider,
    located.payment,
    located.requested,
  );
  if ("outcome" in ready) return ready.outcome;
  const claim = await claimPaymentSession(ready.payment.id, PAYMENT_LEASE_MS);
  if (claim === null) return paymentOutcome(ready.payment, "busy");
  return reconcileClaimedPayment(
    {
      payment: ready.payment,
      provider,
      providerType: storedProviderType,
      requested: located.requested,
    },
    claim,
    ready.initialRead,
    fulfil,
  );
};

/** Fulfil owner-approved stored evidence through the normal fenced fulfil path. */
export const fulfilProvenPayment = async (
  payment: PaymentSession,
  read: Extract<ProviderRead, { status: "found" }>,
  fulfil: FulfilPayment,
): Promise<PaymentReconcileOutcome> => {
  const claim = await claimPaymentSession(payment.id, PAYMENT_LEASE_MS);
  if (claim === null) return paymentOutcome(payment, "busy");
  const resolution: Extract<PaymentResolution, { status: "ready" }> = {
    observation: read.observation,
    status: "ready",
  };
  const observedAt = Date.now();
  const stored = await storePaymentReconciliation(
    claim,
    payment,
    read,
    resolution,
    paymentProgressForResolution(payment, resolution, observedAt),
    true,
    observedAt,
  );
  return runFulfilment(
    stored.payment,
    retainedClaim(stored),
    resolution,
    fulfil,
  );
};
