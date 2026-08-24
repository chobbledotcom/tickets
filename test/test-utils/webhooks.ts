import { expect } from "@std/expect";
import type { SessionMetadata } from "#shared/payments.ts";
import { expectSessionFailed } from "#test-utils/processed-payments.ts";
import type { Attendee } from "#types";
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
  /** The charge's provider resource id. Defaults to a non-blank `pi_<sessionId>`
   *  so an omitted value still yields a processable paid session; pass `null`
   *  explicitly to exercise the boundary's blank-reference rejection. */
  paymentIntent?: string | null;
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
      created: opts.created ?? 1_700_000_000,
      currency: "gbp",
      id: opts.sessionId,
      metadata: opts.metadata,
      payment_intent:
        opts.paymentIntent === undefined
          ? `pi_${opts.sessionId}`
          : opts.paymentIntent,
      payment_status: opts.paymentStatus ?? "paid",
      url: null,
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

/** A signed Stripe event that violates its provider schema must reach the
 * request boundary and fail there instead of becoming an unpaid booking. */
export const expectWebhookRejected = async (
  event: Parameters<typeof stubWebhookVerify>[0],
  message: string,
): Promise<void> => {
  const { handleRequest } = await import("#routes");
  const verify = await stubWebhookVerify(event);
  try {
    await expect(
      handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      ),
    ).rejects.toThrow(message);
  } finally {
    verify.restore();
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

/** Quantity-0 placeholders on a listing that also has booked attendees. */
const getKeptPlaceholders = async (listingId: number): Promise<Attendee[]> => {
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
  return (await getAttendeesRaw(listingId)).filter((a) => a.quantity === 0);
};

export const findKeptPlaceholder = async (
  listingId: number,
): Promise<{ id: number }> => {
  const placeholders = await getKeptPlaceholders(listingId);
  // The invariant this helper documents: exactly one kept placeholder, so a
  // duplicate-placeholder regression fails here rather than silently passing.
  expect(placeholders.length).toBe(1);
  return placeholders[0]!;
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
  const { getNoteRows } = await import("#db/notes/queries.ts");
  expect((await getNoteRows("attendee", [attendeeId])).length).toBe(1);
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
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
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
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
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
 * refunded": the session carries no valid price proof, so ownership cannot be
 * established. It is acknowledged without processing or refunding. A valid
 * proof whose booking will not parse is a different, retryable outcome.
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

/** Assert a listing has exactly one attendee recorded with the given
 *  `price_paid` — the tail check for a processed webhook whose test cares
 *  about the actual amount charged (can_pay_more, amount_total-as-number
 *  extraction, ...) rather than just "an attendee exists". */
export const expectAttendeeWithPricePaid = async (
  listingId: number,
  pricePaid: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
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
): Promise<Attendee> => {
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  expect(attendees[0]?.pii_blob).not.toBe("");
  return attendees[0]!;
};

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
