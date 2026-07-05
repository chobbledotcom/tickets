import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { SessionMetadata } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { assertJson } from "./assertions.ts";
import { mockWebhookRequest } from "./mocks.ts";
import { stubWebhookVerify } from "./settings.ts";

/**
 * The `checkout.session.completed` Stripe event shape almost every
 * `server-webhooks` test feeds into `stubWebhookVerify`: a session `data.object`
 * with the standard amount/id/metadata/payment fields, wrapped in the event
 * envelope. Callers only ever vary these five inputs, so currying them here
 * keeps the (structurally identical) envelope defined in exactly one place
 * instead of hand-copied at every call site.
 */
export const checkoutSessionEvent = (opts: {
  eventId: string;
  sessionId: string;
  amountTotal: number;
  metadata: SessionMetadata | Record<string, string>;
  paymentIntent?: string;
  paymentStatus?: string;
  /** Stripe's `created` (Unix seconds) — the checkout's actual creation time,
   *  for tests asserting a webhook processed late still books against it. */
  created?: number;
}): {
  data: { object: Record<string, unknown> };
  id: string;
  type: "checkout.session.completed";
} => ({
  data: {
    object: {
      amount_total: opts.amountTotal,
      ...(opts.created === undefined ? {} : { created: opts.created }),
      id: opts.sessionId,
      metadata: opts.metadata,
      ...(opts.paymentIntent === undefined
        ? {}
        : { payment_intent: opts.paymentIntent }),
      payment_status: opts.paymentStatus ?? "paid",
    },
  },
  id: opts.eventId,
  type: "checkout.session.completed",
});

/**
 * POST the standard signed webhook request and assert its JSON response,
 * then always run `cleanup` (typically restoring the `verifyWebhookSignature`
 * stub, and any other stub the test installed) — the
 * `try { await assertJson(handleRequest(mockWebhookRequest(...))) } finally {
 * ...restore() }` scaffold that wraps nearly every `server-webhooks` test.
 * Currying the differing parts (expected status, JSON assertions, the
 * cleanup callback, and — rarely — a non-default signature header) here
 * keeps that scaffold defined once instead of hand-copied at every call site.
 */
export const postWebhookAndAssert = async <T = Record<string, unknown>>(
  cleanup: () => void,
  status: number,
  assertions?: (json: T) => void,
  signature = "sig_valid",
): Promise<T> => {
  try {
    return await assertJson<T>(
      handleRequest(mockWebhookRequest({}, { "stripe-signature": signature })),
      status,
      assertions,
    );
  } finally {
    cleanup();
  }
};

/**
 * The "happy path" webhook assertion: stub `verifyWebhookSignature` to return
 * `event`, POST the webhook, and assert it was processed successfully. This is
 * the single most common `server-webhooks` test shape — dozens of tests across
 * many topics (modifiers, promo codes, customisable-days pricing, can_pay_more
 * boundaries, ...) end with exactly this stub-post-assert-restore sequence, so
 * hoisting it here keeps that sequence defined once.
 */
export const expectWebhookProcessed = async (
  event: ReturnType<typeof checkoutSessionEvent>,
): Promise<void> => {
  const mockVerify = await stubWebhookVerify(event);
  await postWebhookAndAssert(
    () => {
      mockVerify.restore();
    },
    200,
    (json) => {
      expect(json.processed).toBe(true);
    },
  );
};

/**
 * The "kept and refunded" webhook assertion: stub `verifyWebhookSignature` to
 * return `event` and `stripeApi.refundPayment` to succeed, POST the webhook,
 * and assert the standard price-mismatch response — acknowledged but not
 * processed, with an error containing `errorContains` (the generic
 * saved-your-details message by default; pass an override for a scenario with
 * its own message, e.g. an inactive/closed listing). Returns the refund stub
 * so the caller can assert on `mockRefund.calls.length` and continue with
 * scenario-specific checks (the quantity-0 placeholder, the system note, the
 * failed `processed_payments` record, ...).
 */
export const expectWebhookKeptAndRefunded = async (
  event: ReturnType<typeof checkoutSessionEvent>,
  refundId = "re_test",
  errorContains = "saved your details",
) => {
  const mockVerify = await stubWebhookVerify(event);
  const mockRefund = stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: refundId } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );
  await postWebhookAndAssert(
    () => {
      mockVerify.restore();
      mockRefund.restore();
    },
    200,
    (json) => {
      expect(json.processed).toBe(false);
      expect(json.error).toContain(errorContains);
    },
  );
  return { mockRefund };
};

/**
 * Assert a webhook session was filed as a terminal failure: no ticket
 * attendee claimed it, so `processed_payments.attendee_id` stays null with
 * `failure_data` set. The tail check of every "kept and refunded" scenario
 * across the price-mismatch / can_pay_more / already-processed suites.
 */
export const expectSessionFailed = async (sessionId: string): Promise<void> => {
  const { isSessionProcessed } = await import(
    "#shared/db/processed-payments.ts"
  );
  const record = await isSessionProcessed(sessionId);
  expect(record?.attendee_id).toBeNull();
  expect(record?.failure_data).not.toBe("");
};

/**
 * Assert the refund fired exactly once and a system note recorded the reason
 * against `attendeeId` — the shared tail of every "kept and refunded"
 * scenario, regardless of how the caller located the quantity-0 placeholder
 * (the sole attendee on a fresh listing, or one of several on a listing that
 * already had a paying attendee).
 */
export const expectRefundedWithNote = async (
  attendeeId: number,
  mockRefund: { calls: unknown[] },
): Promise<void> => {
  expect(mockRefund.calls.length).toBe(1);
  const { getNoteRows } = await import("#shared/db/system-notes.ts");
  expect((await getNoteRows([attendeeId])).length).toBe(1);
};

/**
 * Assert the standard "kept and refunded" aftermath: the order survives as a
 * single quantity-0 placeholder attendee on `listingId` (never dropped), the
 * refund fired exactly once with a system note (see `expectRefundedWithNote`),
 * and (see `expectSessionFailed`) the session is filed as a terminal failure.
 */
export const expectKeptAsQuantityZeroAndRefunded = async (
  listingId: number,
  sessionId: string,
  mockRefund: { calls: unknown[] },
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  expect(attendees[0]!.quantity).toBe(0);
  await expectRefundedWithNote(attendees[0]!.id, mockRefund);
  await expectSessionFailed(sessionId);
};
