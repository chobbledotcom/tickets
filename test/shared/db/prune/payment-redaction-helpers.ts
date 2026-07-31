import type { BookingIntent } from "#shared/booking-intent.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { storeSessionProgress } from "#shared/db/payments/session-record.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import type { PaymentCase } from "#shared/db/payments/types.ts";
import { PAYMENT_HISTORY_REDACTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { bookingCompletion } from "#shared/payment-completion.ts";
import type { PaymentSessionState } from "#shared/payment-state/lifecycle.ts";
import type {
  ProviderChargeResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";

export const oldPaymentTime = (): number =>
  nowMs() - PAYMENT_HISTORY_REDACTION_MS - 60_000;

const paymentIntent = (id: string): BookingIntent => ({
  address: `Secret address ${id}`,
  date: "2026-08-01",
  email: `${id}@private.example`,
  items: [{ e: 7, p: 1_000, q: 1 }],
  listingAnswerIds: { "7": [91] },
  modifiers: [],
  name: `Private buyer ${id}`,
  phone: "+441234567890",
  special_instructions: `Secret instructions ${id}`,
  thankYouUrl: "https://private.example/thanks",
});

const sessionResource = (id: string): ProviderSessionResource => ({
  id: `session-${id}`,
  kind: "stripe_checkout_session",
  provider: "stripe",
});

const chargeResource = (
  id: string,
  session: ProviderSessionResource,
): ProviderChargeResource => ({
  id: `charge-${id}`,
  kind: "stripe_payment_intent",
  parentId: session.id,
  provider: "stripe",
});

const completedBooking = (intent: BookingIntent) => ({
  ...bookingCompletion(
    intent,
    {
      flow: "registration" as const,
      listingId: intent.items[0]!.e,
      occurredAt: "2026-07-01T00:00:00.000Z",
      promos: [{ delta: -100, modifierId: 8, name: "Private promo" }],
    },
    [],
  ),
  effects: {
    answers: "completed" as const,
    balance_activity: "completed" as const,
    external_deliveries: "completed" as const,
    external_delivery_setup: "completed" as const,
    promo_activity: "completed" as const,
    registration_activity: "completed" as const,
  },
});

export interface SeededTerminalPayment {
  charge: ProviderChargeResource;
  id: string;
  intent: BookingIntent;
  session: ProviderSessionResource;
}

export const recordTestPaymentCase = async (
  payment: SeededTerminalPayment,
  observedAt: number = oldPaymentTime(),
): Promise<PaymentCase> =>
  (
    await recordPaymentCase(
      {
        evidence: payment.intent,
        nextReconcileAt: null,
        paymentId: payment.id,
        reason: "owner_checked",
        resource: payment.session,
        state: "needs_action",
      },
      observedAt,
    )
  ).paymentCase;

export const seedTerminalPayment = async (
  id: string,
  options: {
    completionState?: "completed" | "none" | "pending";
    createdAt?: number;
    lease?: boolean;
    nextReconcileAt?: number | null;
    state?: PaymentSessionState;
    storeResult?: boolean;
    ticketReady?: boolean;
  } = {},
): Promise<SeededTerminalPayment> => {
  const createdAt = options.createdAt ?? oldPaymentTime();
  const intent = paymentIntent(id);
  const session = sessionResource(id);
  const charge = chargeResource(id, session);
  const completion = completedBooking(intent);
  const completionState = options.completionState ?? "completed";
  const nextReconcileAt =
    options.nextReconcileAt ??
    (completionState === "pending" ? oldPaymentTime() : null);
  await createPaymentSession(
    {
      accountId: "acct-redaction",
      bookingIntent: intent,
      checkoutCreate: {
        baseUrl: "https://tickets.example",
        bookingIntent: intent,
        expected: { amount: 1_000, currency: "GBP" },
        localPaymentId: id,
        metadata: { name: intent.name, payment_id: id },
        order: {
          extras: [],
          lines: [{ amount: 1_000, name: "Private listing", quantity: 1 }],
        },
      },
      expected: { amount: 1_000, currency: "GBP" },
      id,
      mode: "test",
      provider: "stripe",
      session: null,
    },
    createdAt,
  );
  const readyResult = {
    observation: {
      accountId: "acct-redaction",
      bookingIntent: intent,
      charges: [
        {
          captured: { amount: 1_000, currency: "GBP" },
          confirmedRefunded: { amount: 0, currency: "GBP" },
          refunds: [],
          resource: charge,
        },
      ],
      createdAt: "2026-07-01T00:00:00.000Z",
      expected: { amount: 1_000, currency: "GBP" },
      mode: "test" as const,
      ownership: {
        localPaymentId: id,
        method: "signed" as const,
        signature: `signature-${id}`,
      },
      providerTotal: { amount: 1_000, currency: "GBP" },
      session,
      status: "paid" as const,
    },
    status: "ready" as const,
  };
  const progress = await storeSessionProgress({
    attendeeId: 42,
    completion: completionState === "none" ? null : completion,
    completionState,
    nextReconcileAt,
    result: options.storeResult === false ? null : readyResult,
    resultState: options.storeResult === false ? "none" : "succeeded",
    session,
    state: options.state ?? "completed",
    ticketState: options.ticketReady ? "ready" : "consumed",
    ticketTokens: options.ticketReady ? [`ticket-${id}`] : null,
  });
  await getDb().execute({
    args: [
      progress.sessionResource,
      progress.sessionReferenceIndex,
      progress.state,
      progress.nextReconcileAt,
      progress.attendeeId,
      progress.resultState,
      progress.result,
      progress.ticketState,
      progress.ticketTokens,
      progress.completionState,
      progress.completion,
      options.lease ? `lease-${id}` : null,
      options.lease ? createdAt + 1_000 : null,
      createdAt,
      id,
    ],
    sql: `UPDATE payment_sessions
      SET checkout_create = NULL,
          session_resource = ?, session_reference_index = ?, state = ?,
          next_reconcile_at = ?, attendee_id = ?, result_state = ?, result = ?,
          ticket_state = ?, ticket_tokens = ?, completion_state = ?, completion = ?,
          lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ?`,
  });
  await savePaymentCharges(
    id,
    session,
    [
      {
        captured: { amount: 1_000, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [],
        resource: charge,
      },
    ],
    createdAt,
  );
  return { charge, id, intent, session };
};

export const redactedAt = async (id: string): Promise<number | null> =>
  (await queryOne<{ redacted_at: number | null }>(
    "SELECT redacted_at FROM payment_sessions WHERE id = ?",
    [id],
  ))!.redacted_at;
