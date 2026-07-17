import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { SessionMetadata } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { assertJson } from "./assertions.ts";
import { signedMeta } from "./factories.ts";
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
  const { handleRequest } = await import("#routes");
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
 * Stub `verifyWebhookSignature` to return `event`, POST the webhook, assert
 * its JSON response, and restore the stub — the stub-post-assert-restore
 * sequence shared by every single-stub webhook outcome below (only the
 * assertion itself varies: processed, ignored, ...).
 */
const stubAndPostWebhook = async <T = Record<string, unknown>>(
  event: Parameters<typeof stubWebhookVerify>[0],
  assertions: (json: T) => void,
  extraCleanup?: () => void,
): Promise<T> => {
  const mockVerify = await stubWebhookVerify(event);
  return postWebhookAndAssert<T>(
    () => {
      mockVerify.restore();
      extraCleanup?.();
    },
    200,
    assertions,
  );
};

/**
 * The "happy path" webhook assertion: assert the webhook was processed
 * successfully. This is the single most common `server-webhooks` test shape —
 * dozens of tests across many topics (modifiers, promo codes,
 * customisable-days pricing, can_pay_more boundaries, ...) end with exactly
 * this outcome.
 */
export const expectWebhookProcessed = async (
  event: Parameters<typeof stubWebhookVerify>[0],
): Promise<void> => {
  await stubAndPostWebhook(event, (json) => {
    expect(json.received).toBe(true);
    expect(json.processed).toBe(true);
  });
};

/**
 * The staged-refund webhook assertion: stub `verifyWebhookSignature` to
 * return `event` and `stripeApi.refundPayment` to succeed, POST the webhook,
 * and assert the standard price-mismatch response — acknowledged but not
 * processed, with an error containing `errorContains` (the generic
 * saved-your-details message by default; pass an override for a scenario with
 * its own message, e.g. an inactive/closed listing). Returns the refund stub
 * so the caller can assert on `mockRefund.calls.length` and continue with
 * scenario-specific checks for stage removal and the terminal payment record.
 */
export const expectWebhookKeptAndRefunded = async (
  event: Parameters<typeof stubWebhookVerify>[0],
  refundId = "re_test",
  errorContains: string | string[] = "couldn't complete your booking",
  signature?: string,
) => {
  const mockVerify = await stubWebhookVerify(event);
  const mockRefund = stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: refundId, status: "succeeded" } as unknown as Awaited<
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
      expect(json.received).toBe(true);
      expect(json.processed).toBe(false);
      for (const substring of Array.isArray(errorContains)
        ? errorContains
        : [errorContains]) {
        expect(json.error).toContain(substring);
      }
    },
    signature ?? "sig_valid",
  );
  return { mockRefund };
};

/**
 * Assert that a refunded stage left no quantity-zero attendee record.
 */
export const expectNoRefundPlaceholder = async (
  listingId: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const placeholders = (await getAttendeesRaw(listingId)).filter(
    (a) => a.quantity === 0,
  );
  // No quantity-zero attendee may remain after staged refund cleanup.
  expect(placeholders.length).toBe(0);
};

/**
 * Assert a webhook session was filed as a terminal failure: no ticket
 * attendee claimed it, so `processed_payments.attendee_id` stays null with
 * `failure_data` set. The tail check of every staged-refund scenario
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
 * Assert the refund fired exactly once after the staged attendee was removed.
 */
export const expectRefundedWithoutAttendee = async (mockRefund: {
  calls: unknown[];
}): Promise<void> => {
  expect(mockRefund.calls.length).toBe(1);
};

/**
 * Assert the standard staged-refund aftermath: no quantity-zero attendee is
 * retained, the refund fired once, and the terminal replay row remains.
 */
export const expectStagedAttendeeRemovedAndRefunded = async (
  listingId: number,
  sessionId: string,
  mockRefund: { calls: unknown[] },
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  expect(await getAttendeesRaw(listingId)).toEqual([]);
  await expectRefundedWithoutAttendee(mockRefund);
  await expectSessionFailed(sessionId);
};

/**
 * Assert that a refunded multi-listing stage was removed from both listings.
 */
export const expectMultiListingStageRemoved = async (
  listing1Id: number,
  listing2Id: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  expect(await getAttendeesRaw(listing1Id)).toEqual([]);
  expect(await getAttendeesRaw(listing2Id)).toEqual([]);
};

/**
 * Shared tail of every "acknowledged, no throw" webhook outcome
 * (ignored/pending): stub-post-assert `received: true`, then hand `json` to
 * `assertOutcome` for the one field that distinguishes the outcome. Curries
 * the "received" check out of `expectWebhookIgnored`/`expectWebhookPending`
 * so the two differ only in that one assertion.
 */
const expectWebhookAcknowledged = async (
  event: Parameters<typeof stubWebhookVerify>[0],
  assertOutcome: (json: Record<string, unknown>) => void,
  extraCleanup?: () => void,
): Promise<void> => {
  await stubAndPostWebhook(
    event,
    (json) => {
      expect(json.received).toBe(true);
      assertOutcome(json);
    },
    extraCleanup,
  );
};

/**
 * The third canonical webhook outcome alongside "processed" and "kept and
 * refunded": the session carries no valid price proof (corrupt/missing/non-array
 * items, an unparseable body, ...) so it classifies as "ignore" — acknowledged
 * (200, `received: true`) without processing, never a throw or refund.
 */
export const expectWebhookIgnored = (
  event: Parameters<typeof stubWebhookVerify>[0],
  extraCleanup?: () => void,
): Promise<void> =>
  expectWebhookAcknowledged(
    event,
    (json) => expect(json.processed).toBeUndefined(),
    extraCleanup,
  );

/**
 * Stub `stripeApi.retrieveCheckoutSession` — the shape the `/payment/success`
 * redirect handler reads directly from Stripe, as opposed to the webhook's
 * signed-event path (see `checkoutSessionEvent`/`stubWebhookVerify` for that).
 * `email`/`items`/`name` build the standard signed metadata via `signedMeta`;
 * pass `metadata` directly instead for a scenario that needs a non-standard
 * or corrupt shape. The two variants are exclusive by type, so a caller
 * can't hand over a `metadata` blob and stray identity fields at once.
 */
export const stubRetrieveCheckoutSession = (
  session: {
    sessionId: string;
    amountTotal: number;
    paymentIntent: string | null;
    paymentStatus?: string;
  } & (
    | { metadata: Record<string, unknown> }
    | { email: string; items: string; name: string }
  ),
) =>
  stub(stripeApi, "retrieveCheckoutSession", async () => {
    const metadata =
      "metadata" in session
        ? session.metadata
        : signedMeta(
            {
              email: session.email,
              items: session.items,
              name: session.name,
            },
            session.amountTotal,
          );
    const { stagePaymentCallback } = await import("./staged-payments.ts");
    if (session.paymentIntent !== null) {
      await stagePaymentCallback({
        amountTotal: session.amountTotal,
        metadata: metadata as Record<string, string>,
        paymentReference: session.paymentIntent,
        sessionId: session.sessionId,
      });
    }
    return {
      amount_total: session.amountTotal,
      id: session.sessionId,
      metadata,
      payment_intent: session.paymentIntent,
      payment_status: session.paymentStatus ?? "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >;
  });

/** Assert a listing has exactly one attendee recorded with the given
 *  `price_paid` — the tail check for a processed webhook whose test cares
 *  about the actual amount charged (can_pay_more, amount_total-as-number
 *  extraction, ...) rather than just "an attendee exists". */
export const expectAttendeeWithPricePaid = async (
  listingId: number,
  pricePaid: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  expect((attendees[0] as unknown as Record<string, unknown>).price_paid).toBe(
    pricePaid,
  );
};

/** Assert a listing has exactly one attendee whose PII was encrypted on
 *  create — the standard "booking succeeded" check after a processed
 *  single-ticket webhook. */
export const expectAttendeeCreatedWithPiiBlob = async (
  listingId: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  expect(attendees[0]?.pii_blob).not.toBe("");
};

/** Stub `stripeApi.refundPayment` to succeed with the given (or default)
 *  provider refund id — the bare stub for tests that drive the refund
 *  through the `/payment/success` redirect path directly rather than through
 *  `expectWebhookKeptAndRefunded`. */
export const stubRefundPayment = (refundId = "re_test") =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: refundId, status: "succeeded" } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

/**
 * A fourth webhook outcome alongside processed/kept-and-refunded/ignored: the
 * session is treated as unpaid (an invalid or not-yet-settled payment
 * status), so the webhook acknowledges it as a pending retry rather than
 * processing, refunding, or dropping it.
 */
export const expectWebhookPending = (
  event: Parameters<typeof stubWebhookVerify>[0],
  extraCleanup?: () => void,
): Promise<void> =>
  expectWebhookAcknowledged(
    event,
    (json) => expect(json.status).toBe("pending"),
    extraCleanup,
  );
