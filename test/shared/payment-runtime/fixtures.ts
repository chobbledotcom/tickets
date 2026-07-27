import * as v from "valibot";
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import { encryptWithKey } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateDataKey, wrapKeyWithToken } from "#shared/crypto/keys.ts";
import { executeBatch } from "#shared/db/client.ts";
import {
  getOpenPaymentCases,
  recordPaymentCase,
} from "#shared/db/payments/cases.ts";
import {
  applyChargeRefund,
  getPaymentCharges,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { beginPaymentDecisionAttempt } from "#shared/db/payments/decision-attempts.ts";
import {
  acceptPaymentDecision,
  retryPaymentDecision,
} from "#shared/db/payments/decisions.ts";
import type {
  LegacyPaymentRuntime,
  LegacyProcessedPayment,
} from "#shared/db/payments/legacy.ts";
import {
  type LegacyPaymentGroup,
  LegacyPaymentRuntimeSchema,
} from "#shared/db/payments/legacy.ts";
import {
  legacyTargetStatements,
  prepareLegacyAttendeePaymentReference,
  prepareLegacyPayment,
} from "#shared/db/payments/legacy-copy.ts";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import {
  createPaymentSession,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import {
  LegacyPaymentChargeSchema,
  type PaymentCase,
  type PaymentCaseDecision,
  type PaymentCharge,
  type PaymentSession,
  type PaymentSessionCreate,
} from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { preparePaymentDecision } from "#shared/payment-runtime/operator-claim.ts";
import type { PaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import { getPaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import type {
  PaymentOperatorDecision,
  PaymentOperatorSelection,
} from "#shared/payment-state/lifecycle.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_COMPLETED_BOOKING,
  PAYMENT_ID,
  PAYMENT_INTENT,
  PAYMENT_TIME,
  paymentSessionInput,
  SESSION_RESOURCE,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import { currentCharges } from "#test-utils/current-charge.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import { required } from "#test-utils/required.ts";

export const createPendingPayment = async (
  input: PaymentSessionCreate = paymentSessionInput(),
): Promise<Awaited<ReturnType<typeof createPaymentSession>>> => {
  settings.setForTest({
    payment_provider: "stripe",
    stripe_secret_key: "sk_test_reconciliation",
  });
  const account = await resolvePaymentAccount(input.provider);
  return createPaymentSession(
    { ...input, accountId: account.accountId, mode: account.mode },
    PAYMENT_TIME,
  );
};

export const createRefundablePayment = async (
  chargeCount = 1,
): Promise<{ charges: PaymentCharge[]; payment: PaymentSession }> => {
  settings.setForTest({
    payment_provider: "stripe",
    stripe_secret_key: "sk_test_refund-runtime",
  });
  const account = await resolvePaymentAccount("stripe");
  await createPaymentSession(
    { ...paymentSessionInput(), accountId: account.accountId },
    PAYMENT_TIME,
  );
  const processing = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  await applyPaymentSessionClaim(
    processing,
    sessionProgress({ state: "processing" }),
  );
  const completing = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  const payment = await applyPaymentSessionClaim(
    completing,
    sessionProgress({ state: "completed" }),
  );
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    Array.from({ length: chargeCount }, (_, index) => ({
      captured: { amount: 1_000, currency: "GBP" },
      confirmedRefunded: { amount: 0, currency: "GBP" },
      refunds: [],
      resource: {
        ...CHARGE_RESOURCE,
        id: `${CHARGE_RESOURCE.id}-${index + 1}`,
      },
    })),
    PAYMENT_TIME,
  );
  return {
    charges: currentCharges(await getPaymentCharges(PAYMENT_ID)),
    payment,
  };
};

/** A payment whose only charge the provider has already refunded in full. */
export const createFullyRefundedPayment = async (): Promise<{
  charge: PaymentCharge;
  payment: PaymentSession;
}> => {
  const { charges, payment } = await createRefundablePayment();
  const charge = required(charges[0], "a refundable charge");
  const request = await requestChargeRefund(
    charge.id,
    "completed-refund-request",
    PAYMENT_TIME,
  );
  const refunded = await applyChargeRefund(
    charge.id,
    request.idempotencyKey,
    charge.captured,
    { amount: charge.captured, status: "completed" },
    PAYMENT_TIME + 1,
  );
  // The payment moved on when the refund landed, so hand back how it reads now.
  return {
    charge: refunded,
    payment: required(
      (await getPaymentSessions([payment.id]))[0],
      "the refunded payment",
    ),
  };
};

export const createRefundablePaymentCase = async (
  reason = "partial_refund",
): Promise<
  Awaited<ReturnType<typeof createRefundablePayment>> & {
    paymentCase: PaymentCase;
  }
> => {
  const target = await createRefundablePayment(2);
  const paymentCase = (
    await recordPaymentCase(
      {
        evidence: target.payment.bookingIntent,
        nextReconcileAt: null,
        paymentId: target.payment.id,
        reason,
        resource: SESSION_RESOURCE,
        state: "needs_action",
      },
      PAYMENT_TIME,
    )
  ).paymentCase;
  return { ...target, paymentCase };
};

export const createAcceptedPaymentDecision = async (
  paymentCase: PaymentCase,
  selection: PaymentOperatorSelection,
  exact: PaymentOperatorDecision | null = null,
): Promise<PaymentCaseDecision> => {
  const context = required(
    await getPaymentOperatorCase(paymentCase.id),
    "the payment case",
  );
  const prepared = preparePaymentDecision(
    context,
    1,
    paymentCase.revision,
    "Checked the stored payment facts",
    selection,
    PAYMENT_TIME,
  );
  return acceptPaymentDecision(
    paymentCase.id,
    prepared.claim,
    exact ?? prepared.decision,
  );
};

export const createAcceptedRefundDecision = async (): Promise<
  Awaited<ReturnType<typeof createRefundablePaymentCase>> & {
    decision: PaymentCaseDecision;
  }
> => {
  const target = await createRefundablePaymentCase();
  const decision = await createAcceptedPaymentDecision(target.paymentCase, {
    kind: "refund_remaining",
  });
  return { ...target, decision };
};

export const createRetryingPaymentDecision = async (
  paymentCase: PaymentCase,
  selection: PaymentOperatorSelection,
  exact: PaymentOperatorDecision | null,
): Promise<Awaited<ReturnType<typeof acceptPaymentDecision>>> => {
  const accepted = await createAcceptedPaymentDecision(
    paymentCase,
    selection,
    exact,
  );
  const attempt = await beginPaymentDecisionAttempt(
    accepted.id,
    PAYMENT_TIME + 1,
  );
  if (attempt.status !== "running")
    throw new Error("Expected a running decision");
  await retryPaymentDecision(
    accepted.id,
    "Waiting to resume",
    PAYMENT_TIME + 2,
  );
  return accepted;
};

export const createLegacyAttendeePaymentCase = async (
  reference: string,
  attendeeId = 42,
): Promise<PaymentCase> => {
  const prepared = required(
    await prepareLegacyAttendeePaymentReference(attendeeId, reference),
    "the legacy payment",
  );
  await executeBatch(legacyTargetStatements(prepared));
  const paymentCase = (await getOpenPaymentCases()).find(
    (candidate) =>
      candidate.paymentId === prepared.id &&
      candidate.reason === "legacy_provider_unknown",
  );
  return required(paymentCase, "the provider case");
};

export const paymentProviderRead = (
  changes: Partial<
    Extract<ProviderRead, { status: "found" }>["observation"]
  > = {},
): ProviderRead => ({
  observation: {
    accountId: "acct_test_1",
    bookingIntent: PAYMENT_INTENT,
    charges: [
      {
        captured: { amount: 1_000, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [],
        resource: CHARGE_RESOURCE,
      },
    ],
    createdAt: "2026-07-26T12:00:00.000Z",
    expected: { amount: 1_000, currency: "GBP" },
    mode: "test",
    ownership: {
      localPaymentId: PAYMENT_ID,
      method: "staged",
      stageId: SESSION_RESOURCE.id,
    },
    providerTotal: { amount: 1_000, currency: "GBP" },
    session: SESSION_RESOURCE,
    status: "paid",
    ...changes,
  },
  requested: SESSION_RESOURCE,
  returned: SESSION_RESOURCE,
  status: "found",
});

export const paymentCharge = (
  changes: Partial<PaymentCharge> = {},
): PaymentCharge => ({
  captured: { amount: 1_000, currency: "GBP" },
  createdAt: PAYMENT_TIME,
  id: 1,
  observedAt: PAYMENT_TIME,
  paymentId: PAYMENT_ID,
  pendingRefund: null,
  pendingRefundIdempotencyKey: "refund-key",
  providerReference: CHARGE_RESOURCE,
  refunded: { amount: 0, currency: "GBP" },
  refundState: "requested",
  updatedAt: PAYMENT_TIME,
  ...changes,
});

const paymentCase = (
  evidence: PaymentCase["evidence"],
  reason: string,
): PaymentCase => ({
  alertedAt: PAYMENT_TIME,
  alertSentAt: null,
  alertSentRevision: null,
  consecutiveCount: 1,
  evidence,
  firstObservedAt: PAYMENT_TIME,
  id: 1,
  lastObservedAt: PAYMENT_TIME,
  nextReconcileAt: null,
  paymentId: PAYMENT_ID,
  reason,
  resolvedAt: null,
  resource: SESSION_RESOURCE,
  revision: 1,
  state: "needs_action",
});

export const provenPaymentOperatorCase = (): PaymentOperatorCase => {
  const input = paymentSessionInput();
  const read = paymentProviderRead();
  return {
    case: paymentCase({ kind: "provider_read", read }, "multiple_charges"),
    charges: [
      paymentCharge({
        pendingRefundIdempotencyKey: null,
        refundState: "none",
      }),
    ],
    decisions: [],
    payment: {
      origin: "current",
      value: {
        ...input,
        ...sessionProgress({ nextReconcileAt: null, state: "needs_action" }),
        createdAt: PAYMENT_TIME,
        leaseExpiresAt: null,
        revision: 1,
        updatedAt: PAYMENT_TIME,
      },
    },
  };
};

export const legacyPaymentOperatorCase = (): PaymentOperatorCase => ({
  case: {
    ...paymentCase(PAYMENT_INTENT, "legacy_provider_unknown"),
    resource: {
      id: "legacy-payment:provider",
      kind: "legacy_payment",
      source: "attendee_merge",
    },
  },
  charges: [
    v.parse(LegacyPaymentChargeSchema, {
      createdAt: PAYMENT_TIME,
      id: 1,
      observedAt: PAYMENT_TIME,
      paymentId: PAYMENT_ID,
      providerReference: "hyb:1:legacy-reference",
      providerRefundedAt: null,
      refundState: "unknown",
      source: "attendee_merge",
      updatedAt: PAYMENT_TIME,
    }),
  ],
  decisions: [],
  payment: {
    origin: "legacy",
    value: {
      accountId: null,
      attendeeId: 42,
      id: PAYMENT_ID,
      mode: null,
      provider: null,
      revision: 1,
      runtime: v.parse(LegacyPaymentRuntimeSchema, {
        attendeePayment: {
          attendeeId: 42,
          createdAt: "2026-07-26T12:00:00.000Z",
          paymentReference: "hyb:1:legacy-reference",
          source: "attendee_merge",
        },
        checkoutStage: null,
        processedPayment: null,
        sumupCheckout: null,
      }),
      state: "needs_action",
    },
  },
});

export const getStoredPayment = async (): Promise<PaymentSession> => {
  const [payment] = await getPaymentSessions([PAYMENT_ID]);
  return required(payment, "the stored payment");
};

export const completePayment = async (
  work: PaymentWork,
): Promise<PaymentResult> => {
  await applyPaymentSessionClaim(work.claim, {
    attendeeId: 42,
    completion: PAYMENT_COMPLETED_BOOKING,
    completionState: "completed",
    nextReconcileAt: null,
    result: work.resolution,
    resultState: "succeeded",
    session: SESSION_RESOURCE,
    state: "completed",
    ticketState: "ready",
    ticketTokens: ["ticket-one"],
  });
  return {
    attendee: { id: 42 },
    listingId: 7,
    success: true,
    ticketTokens: ["ticket-one"],
  };
};

/** Put one old SumUp checkout in the database, the way a site that has not
 *  been upgraded yet would still hold it. */
export const createLegacySumupCheckout = async (
  reference: string,
  sumupId: string,
  options: {
    /** A checkout the buyer already finished paying for, before the upgrade. */
    finished?: boolean;
    /** Which old row this checkout was found in. One reference can be reached
     *  under two of these, which is how a site ends up with two of them. */
    filedUnder?: "session" | "sumup";
  } = {},
): Promise<void> => {
  const { filedUnder = "sumup", finished = false } = options;
  settings.setForTest({
    currency: "GBP",
    payment_provider: "sumup",
    sumup_api_key: "sk_test_legacy",
    sumup_merchant_code: "merchant-legacy",
  });
  const dataKey = await generateDataKey();
  const metadata = signedMeta(
    {
      email: "legacy@example.com",
      items: singleItem(7, 1, 1_000),
      name: "Legacy buyer",
    },
    1_000,
  );
  const group: LegacyPaymentGroup = {
    key:
      filedUnder === "sumup"
        ? `sumup:${await hmacHash(reference)}`
        : `session:${reference}`,
    runtime: {
      attendeePayment: null,
      checkoutStage: null,
      processedPayment: finished
        ? {
            attendeeId: 42,
            failureData: "",
            listingId: 7,
            paymentReference: "",
            paymentSessionId: reference,
            processedAt: "2026-07-26T12:05:00.000Z",
            providerRefundedAt: "",
            ticketTokens: "",
          }
        : null,
      sumupCheckout: {
        createdAt: "2026-07-26T12:00:00.000Z",
        metadata: await encryptWithKey(JSON.stringify(metadata), dataKey),
        referenceIndex: await hmacHash(reference),
        sumupId,
        wrappedKey: await wrapKeyWithToken(dataKey, reference),
      },
    },
  };
  await executeBatch(legacyTargetStatements(await prepareLegacyPayment(group)));
};

/** One old payment record, as it reads after the upgrade copied it across.
 *  Nothing is filled in by default — each test adds only the parts it needs. */
export const legacyReplay = (
  runtime: Partial<LegacyPaymentRuntime> = {},
  values: Partial<Omit<LegacyPaymentReplay, "runtime">> = {},
): LegacyPaymentReplay => ({
  accountId: null,
  attendeeId: null,
  id: "legacy:sumup:example",
  mode: null,
  provider: null,
  revision: 1,
  runtime: {
    attendeePayment: null,
    checkoutStage: null,
    processedPayment: null,
    sumupCheckout: null,
    ...runtime,
  },
  state: "pending",
  ...values,
});

/** One "we already dealt with this" row from before the upgrade. */
export const legacyProcessedPayment = (
  values: Partial<LegacyProcessedPayment> = {},
): LegacyProcessedPayment => ({
  attendeeId: null,
  failureData: "",
  listingId: null,
  paymentReference: "",
  paymentSessionId: "legacy-session",
  processedAt: "2026-07-25T10:01:00.000Z",
  providerRefundedAt: "",
  ticketTokens: "",
  ...values,
});
