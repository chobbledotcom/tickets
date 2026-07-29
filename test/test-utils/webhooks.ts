import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import { ProviderMetadataSchema } from "#shared/payment-helpers.ts";
import { foundProviderPayment } from "#shared/payment-runtime/provider-read.ts";
import { ObservedPaymentStatusSchema } from "#shared/payment-state/observation.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { Attendee } from "#shared/types.ts";
import { required } from "#test-utils/required.ts";
import { assertJson } from "./assertions.ts";
import { signedMeta } from "./factories.ts";
import { mockWebhookRequest } from "./mocks.ts";
import { type ProviderNoticeFixture, stubWebhookVerify } from "./settings.ts";
import {
  stripeCharge,
  stripePaymentIntent,
  stripeRefund,
} from "./stripe/fixtures.ts";

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
  /** `null` means the provider says it is paid but has not attached the
   *  payment yet, so the notice carries no charge. */
  paymentIntent?: string | null;
  paymentStatus?: string;
  /** Stripe's `created` (Unix seconds) — the checkout's actual creation time,
   *  for tests asserting a webhook processed late still books against it. */
  created?: number;
}): ProviderNoticeFixture => {
  const session = {
    id: opts.sessionId,
    kind: "stripe_checkout_session" as const,
    provider: "stripe" as const,
  };
  const paymentReference = opts.paymentIntent ?? `pi_${opts.sessionId}`;
  const charges =
    opts.amountTotal === 0 || opts.paymentIntent === null
      ? undefined
      : [
          {
            captured: { amount: opts.amountTotal, currency: "GBP" },
            confirmedRefunded: { amount: 0, currency: "GBP" },
            refunds: [],
            resource: {
              id: paymentReference,
              kind: "stripe_payment_intent" as const,
              parentId: opts.sessionId,
              provider: "stripe" as const,
            },
          },
        ];
  const asked =
    opts.paymentStatus ??
    (opts.amountTotal === 0 ? "no_payment_required" : "paid");
  // A status the system does not know reads as "not paid yet", which is how a
  // test can hand the webhook a status Stripe would never send.
  const paymentStatus = v.is(ObservedPaymentStatusSchema, asked)
    ? asked
    : "pending";
  return {
    notice: {
      eventId: opts.eventId,
      resource: session,
      type: "checkout.session.completed",
    },
    paidAmount: opts.amountTotal,
    read: (payment, requested) =>
      foundProviderPayment(
        payment,
        requested,
        session,
        { amount: opts.amountTotal, currency: "GBP" },
        paymentStatus,
        {
          ...(charges === undefined ? {} : { charges }),
          createdAt: new Date(
            (opts.created ?? 1_700_000_000) * 1_000,
          ).toISOString(),
          metadata: v.parse(ProviderMetadataSchema, opts.metadata),
        },
      ),
  };
};

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
  // The callback books the ticket and leaves the rest — answers, activity
  // entries, outgoing messages — for scheduled maintenance, so finish that
  // work here and leave the booking as the site has it a moment later.
  const { settleDeferredPaymentWork } = await import("./maintenance.ts");
  await settleDeferredPaymentWork();
};

/**
 * The "kept and refunded" webhook assertion: stub `verifyWebhookSignature` to
 * return `event` and `stripeApi.requestRefund` to succeed, POST the webhook,
 * and assert the standard money-returned response: the notice is acknowledged,
 * the booking was not processed, and the payment ends up fully refunded. The
 * reason the money went back is not in this response — it is kept on the
 * booking's system note, so a scenario that cares about the wording asserts it
 * with `expectRefundNote`. Returns the refund stub so the caller can assert on
 * `mockRefund.calls.length` and continue with scenario-specific checks (the
 * quantity-0 placeholder, the system note, and the terminal payment aggregate).
 */
export const expectWebhookKeptAndRefunded = async (
  event: ProviderNoticeFixture,
  refundId = "re_test",
  signature?: string,
) => {
  const mockVerify = await stubWebhookVerify(event);
  const mockRefund = stubRefundPayment(refundId, event.paidAmount);
  await postWebhookAndAssert(
    () => {
      mockVerify.restore();
      mockRefund.restore();
    },
    200,
    (json) => {
      expect(json.received).toBe(true);
      expect(json.processed).toBe(false);
      expect(json.status).toBe("fully_refunded");
    },
    signature ?? "sig_valid",
  );
  return { mockRefund };
};

/** Quantity-0 placeholders on a listing that also has booked attendees. */
const getKeptPlaceholders = async (listingId: number): Promise<Attendee[]> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
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

/** A terminal payment failure has no ticket attendee and keeps its details. */
export const expectSessionFailed = async (sessionId: string): Promise<void> => {
  const { requirePaymentAggregateByProviderSession } = await import(
    "#test-utils/payment-aggregate.ts"
  );
  const payment = await requirePaymentAggregateByProviderSession(sessionId);
  expect(payment.attendeeId).not.toBeNull();
  expect(payment.completion?.kind).toBe("placeholder_refund");
  expect(payment.state).toBe("fully_refunded");
};

/**
 * Assert a payment page turned the visitor away because the checkout could not
 * be shown to be ours — an unsigned or unreadable one, or a session the
 * provider does not know.
 */
export const expectUnrecognisedPayment = async (
  response: Response,
): Promise<void> => {
  const { t } = await import("#i18n");
  const { expectHtmlResponse } = await import("./assertions.ts");
  await expectHtmlResponse(
    response,
    400,
    t("payment.error.session_not_recognized"),
  );
};

/**
 * Drive a payment callback for a checkout whose stored details cannot be read,
 * and assert the visitor is told it is not recognised. Shared by the success
 * and cancel pages, which answer an unreadable checkout the same way.
 */
export const expectUnreadableSessionRejected = async (
  path: string,
  sessionId: string,
): Promise<void> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, withMocks } = await import("./mocks.ts");
  await withMocks(
    () =>
      stubRetrieveCheckoutSession({
        amountTotal: 0,
        metadata: {},
        paymentIntent: null,
        paymentStatus: "unpaid",
        sessionId,
      }),
    async () => {
      await expectUnrecognisedPayment(
        await handleRequest(mockRequest(`${path}?session_id=${sessionId}`)),
      );
    },
  );
};

/**
 * Assert a listing kept exactly one booking, held at quantity 0 so it takes
 * nobody's place while the money goes back.
 */
export const expectKeptAtQuantityZero = async (
  listingId: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const kept = await getAttendeesRaw(listingId);
  expect(kept).toHaveLength(1);
  expect(kept[0]!.quantity).toBe(0);
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
  const { settleDeferredPaymentWork } = await import("./maintenance.ts");
  await settleDeferredPaymentWork();
  expect(mockRefund.calls.length).toBe(1);
  const { getNoteRows } = await import("#shared/db/notes/queries.ts");
  expect((await getNoteRows("attendee", [attendeeId])).length).toBe(1);
};

/**
 * Assert why the money went back: the note kept on the listing's placeholder
 * booking says so. The webhook reply only reports that the payment was
 * refunded, so this is where a scenario checks the wording the operator reads.
 */
export const expectRefundNote = async (
  listingId: number,
  contains: string,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const { getNotesFor } = await import("#shared/db/notes/queries.ts");
  const { attendeeNotes } = await import("#shared/db/notes/target.ts");
  const { getTestPrivateKey } = await import("./crypto.ts");
  const { settleDeferredPaymentWork } = await import("./maintenance.ts");
  await settleDeferredPaymentWork();
  const [attendee] = await getAttendeesRaw(listingId);
  const kept = required(attendee, "a kept booking");
  const notes = await getNotesFor(attendeeNotes(kept.id), await getTestPrivateKey());
  const text = notes.map((note) => note.note).join("\n");
  expect(text).toContain(contains);
};

/**
 * Assert the standard "kept and refunded" aftermath: the order survives as a
 * single quantity-0 placeholder attendee on `listingId` (never dropped), the
 * refund fired exactly once with a system note (see `expectRefundedWithNote`),
 * and (see `expectSessionFailed`) the payment is filed as fully refunded.
 */
export const expectKeptAsQuantityZeroAndRefunded = async (
  listingId: number,
  sessionId: string,
  mockRefund: { calls: unknown[] },
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
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
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
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
    /** When the checkout was made, in Unix seconds. */
    created?: number;
    paymentIntent: string | null;
    paymentStatus?: string;
  } & (
    | { metadata: Record<string, unknown> }
    | { email: string; items: string; name: string }
  ),
) => stubSessionLookup(session);

/** Stub both reads a paid Stripe session needs: the session itself and the
 *  payment intent behind it. The intent mirrors the session's reference and
 *  amount, so the money the provider reports matches what was paid. */
const stubSessionLookup = (
  session: Parameters<typeof stubRetrieveCheckoutSession>[0],
) => {
  const intent = stub(stripeApi, "lookupPaymentIntent", () =>
    Promise.resolve({
      status: "found" as const,
      value: stripePaymentIntent({
        amount: session.amountTotal,
        amount_received: session.amountTotal,
        id: required(session.paymentIntent, "the checkout's payment"),
        latest_charge: stripeCharge({
          amount: session.amountTotal,
          amount_captured: session.amountTotal,
          amount_refunded: 0,
          payment_intent: required(
            session.paymentIntent,
            "the checkout's payment",
          ),
        }),
      }),
    } as unknown as Awaited<ReturnType<typeof stripeApi.lookupPaymentIntent>>),
  );
  const lookup = stub(stripeApi, "lookupCheckoutSession", () =>
    Promise.resolve({
      status: "found" as const,
      value: {
        amount_total: session.amountTotal,
        created: session.created ?? 1_700_000_000,
        currency: "gbp",
        id: session.sessionId,
        livemode: false,
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
        // A checkout that costs nothing never has a payment behind it.
        payment_intent:
          session.amountTotal === 0 ? null : session.paymentIntent,
        payment_status:
          session.paymentStatus ??
          (session.amountTotal === 0 ? "no_payment_required" : "paid"),
        status: "complete",
        url: null,
      },
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.lookupCheckoutSession>
    >),
  );
  return {
    calls: lookup.calls,
    restore: () => {
      lookup.restore();
      intent.restore();
    },
  };
};

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
): Promise<Attendee> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  expect(attendees[0]?.pii_blob).not.toBe("");
  return attendees[0]!;
};

/** Stub `stripeApi.requestRefund` to succeed with the given (or default)
 *  provider refund id — the bare stub for tests that drive the refund
 *  through the `/payment/success` redirect path directly rather than through
 *  `expectWebhookKeptAndRefunded`. */
/**
 * Answer a refund request with a refund that genuinely belongs to the charge
 * being refunded: the payment reference comes straight back from the request,
 * so the provider check that a refund matches its charge is satisfied without
 * every caller restating the id. `amount` must be what is left to refund on
 * the charge, which is the full paid total unless the test refunded part of it
 * already.
 */
export const stubRefundPayment = (refundId = "re_test", amount = 1000) =>
  stub(stripeApi, "requestRefund", (intentId: string) =>
    Promise.resolve(
      stripeRefund({ amount, id: refundId, payment_intent: intentId }),
    ),
  );

/** Assert the provider received both the payment reference and a stable key. */
export const expectRefundPaymentCall = (
  refund: { calls: readonly { args: readonly unknown[] }[] },
  paymentReference: string,
): void => {
  expect(refund.calls[0]?.args[0]).toBe(paymentReference);
  expect(refund.calls[0]?.args[1]).toMatch(/^\S+$/u);
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
