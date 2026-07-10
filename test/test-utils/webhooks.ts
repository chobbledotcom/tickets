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
  event: Parameters<typeof stubWebhookVerify>[0],
  refundId = "re_test",
  errorContains: string | string[] = "saved your details",
  signature?: string,
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
 * Locate the sole quantity-0 placeholder on a listing that already carries
 * other attendees (so `expectKeptAsQuantityZeroAndRefunded`'s "exactly one
 * attendee" check doesn't apply), assert one exists, and return it — the
 * shared way both the redirect and webhook sold-out scenarios find the late
 * buyer's kept placeholder alongside the original attendee.
 */
export const findKeptPlaceholder = async (
  listingId: number,
): Promise<{ id: number }> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
  const placeholders = (await getAttendeesRaw(listingId)).filter(
    (a) => a.quantity === 0,
  );
  // The invariant this helper documents: exactly one kept placeholder, so a
  // duplicate-placeholder regression fails here rather than silently passing.
  expect(placeholders.length).toBe(1);
  return placeholders[0]!;
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

/**
 * Assert a multi-listing order was kept as a single quantity-0 placeholder
 * shared across both listings (never dropped or split), and return that
 * attendee so the caller can continue with its own refund/note/failure
 * checks — the shared "did the two listings merge onto one attendee" check
 * at the top of the `can_pay_more` and price-mismatch multi-ticket
 * "kept and refunded" scenarios.
 */
export const expectMergedMultiListingAttendee = async (
  listing1Id: number,
  listing2Id: number,
): Promise<{ id: number }> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
  const attendees1 = await getAttendeesRaw(listing1Id);
  const attendees2 = await getAttendeesRaw(listing2Id);
  expect(attendees1.length).toBe(1);
  expect(attendees2.length).toBe(1);
  expect(attendees1[0]!.id).toBe(attendees2[0]!.id);
  expect(attendees1[0]!.quantity).toBe(0);
  return attendees1[0]!;
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
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: session.amountTotal,
      id: session.sessionId,
      metadata:
        "metadata" in session
          ? session.metadata
          : signedMeta(
              {
                email: session.email,
                items: session.items,
                name: session.name,
              },
              session.amountTotal,
            ),
      payment_intent: session.paymentIntent,
      payment_status: session.paymentStatus ?? "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

/** Assert a listing has exactly one attendee recorded with the given
 *  `price_paid` — the tail check for a processed webhook whose test cares
 *  about the actual amount charged (can_pay_more, amount_total-as-number
 *  extraction, ...) rather than just "an attendee exists". */
export const expectAttendeeWithPricePaid = async (
  listingId: number,
  pricePaid: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
    Promise.resolve({ id: refundId } as unknown as Awaited<
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
