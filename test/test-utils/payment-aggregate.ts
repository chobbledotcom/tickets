import { expect } from "@std/expect";
import { executeBatch, queryOne } from "#shared/db/client.ts";
import {
  getPaymentCharges,
  paymentChargeStatements,
} from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaim,
  applyPaymentSessionClaimKeepingLease,
  type PaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  createPaymentSession,
  getPaymentSessionByResourceOrNull,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import type {
  PaymentCharge,
  PaymentSession,
  PaymentSessionCreate,
} from "#shared/db/payments/types.ts";
import {
  type BookingCompletion,
  bookingCompletion,
} from "#shared/payment-completion.ts";
import type { RefundPaymentReference } from "#shared/payment-refund-reference.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import {
  getPaymentRefundTargets,
  refundReferences,
} from "#shared/payment-runtime/refund-targets.ts";
import type {
  ChargeLeg,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";
import { currentCharges } from "#test-utils/current-charge.ts";
import { required } from "#test-utils/required.ts";

const PAYMENT_TIME = 1_785_024_000_000;

export interface AggregateChargeFixture {
  amount: number;
  reference: string;
  refundedAmount?: number;
}

export interface AggregatePaymentFixtureInput {
  accountId?: string;
  attendeeId?: number;
  bookingIntent?: PaymentSessionCreate["bookingIntent"];
  charges?: readonly AggregateChargeFixture[];
  configuredAccount?: boolean;
  createdAt?: number;
  currency?: string;
  paymentId: string;
  providerSessionId?: string;
  state?: "completed" | "completion_pending" | "created" | "processing";
  ticketTokens?: string[];
}

export interface AggregatePaymentFixture {
  charges: PaymentCharge[];
  claim: PaymentSessionClaim | null;
  payment: PaymentSession;
  session: ProviderSessionResource;
}

const defaultIntent = (
  paymentId: string,
  amount: number,
): PaymentSessionCreate["bookingIntent"] => ({
  address: "",
  date: null,
  email: `${paymentId}@example.com`,
  items: [{ e: 1, p: amount, q: 1 }],
  modifiers: [],
  name: "Aggregate payment",
  phone: "",
  special_instructions: "",
});

const fixtureBookingCompletion = (
  intent: PaymentSessionCreate["bookingIntent"],
  createdAt: number,
  ticketTokens: string[],
): BookingCompletion =>
  bookingCompletion(
    intent,
    {
      flow: intent.balanceAttendeeId === undefined ? "registration" : "balance",
      listingId: intent.items[0]!.e,
      occurredAt: new Date(createdAt).toISOString(),
      promos: [],
    },
    ticketTokens,
  );

const completedBooking = (
  intent: PaymentSessionCreate["bookingIntent"],
  createdAt: number,
  ticketTokens: string[],
): BookingCompletion => {
  const completion = fixtureBookingCompletion(intent, createdAt, ticketTokens);
  return {
    ...completion,
    effects: {
      answers: "completed",
      balance_activity: "completed",
      external_deliveries: "completed",
      external_delivery_setup: "completed",
      promo_activity: "completed",
      registration_activity: "completed",
    },
  };
};

const chargeLegs = (
  session: ProviderSessionResource,
  currency: string,
  charges: readonly AggregateChargeFixture[],
): ChargeLeg[] =>
  charges.map(({ amount, reference, refundedAmount = 0 }) => ({
    captured: { amount, currency },
    confirmedRefunded: { amount: refundedAmount, currency },
    refunds: [],
    resource: {
      id: reference,
      kind: "stripe_payment_intent",
      parentId: session.id,
      provider: "stripe",
    },
  }));

const aggregateFixture = async (
  payment: PaymentSession,
  session: ProviderSessionResource,
  claim: PaymentSessionClaim | null,
): Promise<AggregatePaymentFixture> => ({
  charges: currentCharges(await getPaymentCharges(payment.id)),
  claim,
  payment,
  session,
});

const finishAggregatePayment = async (
  input: AggregatePaymentFixtureInput,
  intent: PaymentSessionCreate["bookingIntent"],
  createdAt: number,
  session: ProviderSessionResource,
  processing: Awaited<ReturnType<typeof applyPaymentSessionClaimKeepingLease>>,
): Promise<AggregatePaymentFixture> => {
  if (input.state === "processing") {
    return aggregateFixture(processing.payment, session, processing.claim);
  }
  if (input.state === "completion_pending") {
    const ticketTokens = input.ticketTokens ?? ["pending-ticket"];
    const payment = await applyPaymentSessionClaim(
      processing.claim,
      paymentProgress(processing.payment, {
        completion: fixtureBookingCompletion(intent, createdAt, ticketTokens),
        completionState: "pending",
        nextReconcileAt: createdAt + 60_000,
        state: "processing",
        ticketState: "ready",
        ticketTokens,
      }),
    );
    return aggregateFixture(payment, session, null);
  }
  const ticketTokens = input.ticketTokens ?? [];
  const payment = await applyPaymentSessionClaim(
    processing.claim,
    paymentProgress(processing.payment, {
      attendeeId: required(
        input.attendeeId,
        `an attendee for completed payment ${processing.payment.id}`,
      ),
      completion: completedBooking(intent, createdAt, ticketTokens),
      completionState: "completed",
      nextReconcileAt: null,
      state: "completed",
      ticketState: ticketTokens.length === 0 ? "consumed" : "ready",
      ticketTokens: ticketTokens.length === 0 ? null : ticketTokens,
    }),
  );
  return aggregateFixture(payment, session, null);
};

/** Create one current payment aggregate through its repositories. */
export const createAggregatePayment = async (
  input: AggregatePaymentFixtureInput,
): Promise<AggregatePaymentFixture> => {
  const createdAt = input.createdAt ?? PAYMENT_TIME;
  const currency = input.currency ?? "GBP";
  const chargeInputs = input.charges ?? [];
  const amount = chargeInputs.reduce(
    (total, charge) => total + charge.amount,
    0,
  );
  const expectedAmount = amount === 0 ? 100 : amount;
  const intent =
    input.bookingIntent ?? defaultIntent(input.paymentId, expectedAmount);
  const account =
    input.accountId !== undefined
      ? { accountId: input.accountId, mode: "test" as const }
      : input.configuredAccount === true
        ? await resolvePaymentAccount("stripe")
        : { accountId: "acct_test_fixture", mode: "test" as const };
  const session: ProviderSessionResource = {
    id: input.providerSessionId ?? input.paymentId,
    kind: "stripe_checkout_session",
    provider: "stripe",
  };
  const payment = await createPaymentSession(
    {
      accountId: account.accountId,
      bookingIntent: intent,
      checkoutCreate: null,
      expected: { amount: expectedAmount, currency },
      id: input.paymentId,
      mode: account.mode,
      provider: "stripe",
      session,
    },
    createdAt,
  );
  const legs = chargeLegs(session, currency, chargeInputs);
  await savePaymentCharges(payment.id, session, legs, createdAt);
  if ((input.state ?? "completed") === "created") {
    return aggregateFixture(payment, session, null);
  }

  const firstClaim = await requirePaymentSessionClaim(payment.id, 60_000);
  const processing = await applyPaymentSessionClaimKeepingLease(
    firstClaim,
    paymentProgress(payment, {
      attendeeId: input.attendeeId ?? null,
      nextReconcileAt: createdAt + 60_000,
      state: "processing",
    }),
  );
  return finishAggregatePayment(input, intent, createdAt, session, processing);
};

/** The stored payment with this id. Every caller is checking a payment it has
 *  just made, so a missing one is a broken test rather than an outcome. */
export const getPaymentAggregate = async (
  paymentId: string,
): Promise<PaymentSession> =>
  required((await getPaymentSessions([paymentId]))[0], `payment ${paymentId}`);

export const getPaymentAggregateByProviderSessionOrNull = (
  sessionId: string,
): Promise<PaymentSession | null> =>
  getPaymentSessionByResourceOrNull({
    id: sessionId,
    kind: "stripe_checkout_session",
    provider: "stripe",
  });

export const requirePaymentAggregateByProviderSession = async (
  sessionId: string,
): Promise<PaymentSession> => {
  const payment = await getPaymentAggregateByProviderSessionOrNull(sessionId);
  if (payment === null) throw new Error(`Payment ${sessionId} was not stored`);
  return payment;
};

export const refundReferencesForAttendee = async (
  attendeeId: number,
): Promise<RefundPaymentReference[]> => {
  const targets = await getPaymentRefundTargets([attendeeId]);
  return refundReferences(targets.get(attendeeId) ?? []);
};

export const expectRefundReferences = async (
  attendeeId: number,
  expectedReferences: readonly string[],
): Promise<void> => {
  expect(
    (await refundReferencesForAttendee(attendeeId)).map(
      (reference) => reference.reference,
    ),
  ).toEqual(expectedReferences);
};

export interface PausedAttendeePayment extends AggregatePaymentFixture {
  claim: PaymentSessionClaim;
}

export const createPausedAttendeePayment = async (
  paymentId: string,
  attendeeId: number,
): Promise<PausedAttendeePayment> => {
  const payment = await createAggregatePayment({
    accountId: "acct_attendee_fence",
    attendeeId,
    paymentId,
    state: "processing",
  });
  return { ...payment, claim: required(payment.claim, "the retained claim") };
};

export const expectAttendeePaymentFence = async (
  fixture: PausedAttendeePayment,
  staleAttendeeId: number,
  expectedAttendeeId: number | null,
): Promise<void> => {
  await expect(
    applyPaymentSessionClaim(
      fixture.claim,
      paymentProgress(fixture.payment, {
        attendeeId: staleAttendeeId,
        nextReconcileAt: fixture.payment.createdAt + 60_000,
        state: "processing",
      }),
    ),
  ).rejects.toThrow(`Lost payment session lease for ${fixture.payment.id}`);
  expect(
    await queryOne<{
      attendee_id: number | null;
      lease_expires_at: number | null;
      lease_token: string | null;
      revision: number;
    }>(
      `SELECT attendee_id, lease_token, lease_expires_at, revision
         FROM payment_sessions AS paymentSession
        WHERE paymentSession.id = ?`,
      [fixture.payment.id],
    ),
  ).toEqual({
    attendee_id: expectedAttendeeId,
    lease_expires_at: null,
    lease_token: null,
    revision: fixture.claim.revision + 1,
  });
};

/**
 * Write a payment's charges on their own. The site always writes charges
 * inside a bigger batch, so this standalone write exists to seed a test's
 * starting state.
 */
export const savePaymentCharges = async (
  paymentId: string,
  session: ProviderSessionResource,
  charges: readonly ChargeLeg[],
  observedAt: number,
): Promise<void> => {
  const statements = await paymentChargeStatements(
    paymentId,
    session,
    charges,
    observedAt,
  );
  if (statements.length > 0) await executeBatch(statements);
};
