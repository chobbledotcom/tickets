import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { checkoutSessionEvent } from "#test-utils/webhooks.ts";

/**
 * The three-verdict trust model. A paid session's price proof is the ONLY signal
 * that it is ours: it cannot be forged without our signing key, and our checkout
 * always attaches one, so the unsigned `_origin` marker plays no part. Every
 * session classifies as exactly one of:
 *
 *  - trusted  (valid proof, charge == signed total): processed.
 *  - mismatch (valid proof, charge != signed total): a payment we signed, so it
 *             is never dropped — the booking is KEPT as a quantity-0 placeholder,
 *             refunded, and flagged with a system note.
 *  - ignore   (no valid proof — absent, malformed, tampered, or foreign):
 *             acknowledged without processing or refunding (we can't prove it is
 *             ours, and refunding an unverifiable session could refund another
 *             instance's payment).
 *
 * These tests drive every verdict through the real webhook/redirect entrypoints,
 * plus the failed-refund behaviour a stored booking depends on.
 */

export const signedMeta = (
  total: number,
  fields: {
    items: string;
    name?: string;
    email?: string;
    modifiers?: string;
  },
): Record<string, string> =>
  signMeta(
    webhookMeta({
      email: "buyer@example.com",
      name: "Buyer",
      ...fields,
    }),
    total,
  );

/** Stub the Stripe provider to return a completed (paid) checkout session. */
export const stubCompletedSession = async (object: {
  amount_total: number;
  id: string;
  metadata: Record<string, string>;
}) =>
  stubWebhookVerify(
    checkoutSessionEvent({
      amountTotal: object.amount_total,
      eventId: `evt_${object.id}`,
      metadata: object.metadata,
      paymentIntent: `pi_${object.id}`,
      sessionId: object.id,
    }),
  );

export const webhookRequest = () =>
  handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

export const redirectRequest = (id: string) =>
  handleRequest(mockRequest(`/payment/success?session_id=${id}`));

/** Stub the provider refund to succeed (deterministic — no network). */
export const stubRefundOk = () =>
  stub(stripePaymentProvider, "refundCharge", (charge) =>
    Promise.resolve({ amount: charge.captured, status: "completed" as const }),
  );

/** setupStripe + a 50-seat listing priced at 1000. */
export const setupWithListing = async () => {
  await setupStripe();
  return createTestListing({ maxAttendees: 50, unitPrice: 1000 });
};

/** Drive a completed (paid) session through the webhook with a refund stub
 *  installed; `body` receives the refund spy. All stubs are restored after. */
export const runWebhook = async (
  session: {
    id: string;
    metadata: Record<string, string>;
    amount_total?: number;
  },
  body: (refund: ReturnType<typeof stubRefundOk>) => Promise<void>,
): Promise<void> => {
  const refund = stubRefundOk();
  const mockVerify = await stubCompletedSession({
    amount_total: session.amount_total ?? 1000,
    id: session.id,
    metadata: session.metadata,
  });
  try {
    await body(refund);
  } finally {
    mockVerify.restore();
    refund.restore();
  }
};

/** Drive a mismatch (charged 1200, signed 1000) whose refund returns null, with
 *  the payment intent's refunded state stubbed; `body` receives the refund spy. */
export const runFailedRefund = async (
  id: string,
  intentRefunded: boolean,
  listingId: number,
  body: (refund: ReturnType<typeof stubRefundOk>) => Promise<void>,
): Promise<void> => {
  const refund = stub(stripePaymentProvider, "refundCharge", (charge) =>
    Promise.resolve(
      intentRefunded
        ? { amount: charge.captured, status: "completed" as const }
        : {
            amount: charge.refunded,
            reason: "provider_failed" as const,
            status: "failed" as const,
          },
    ),
  );
  const mockVerify = await stubCompletedSession({
    amount_total: 999,
    id,
    metadata: signedMeta(999, { items: singleItem(listingId, 1, 999) }),
  });
  try {
    await body(refund);
  } finally {
    mockVerify.restore();
    refund.restore();
  }
};

/** Assert the webhook kept the booking as a quantity-0 placeholder. */
export const expectStoredRefundRecord = async (
  listingId: number,
): Promise<void> => {
  const [attendee] = await getAttendeesRaw(listingId);
  expect(attendee?.quantity).toBe(0);
};

export const expectStoredRefund = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(false);
    expect(json.status).toBe("fully_refunded");
  });
  await expectStoredRefundRecord(listingId);
};

/** Assert the webhook acknowledges (200) and silently ignores the session. */
export const expectAcknowledgedIgnore = () =>
  assertJson(webhookRequest(), 200, (json) => {
    expect(json.received).toBe(true);
    expect(json.processed).toBeUndefined();
  });

/** Assert no attendee rows were created for the listing. */
export const expectNoAttendees = async (listingId: number): Promise<void> => {
  expect((await getAttendeesRaw(listingId)).length).toBe(0);
};

/** Assert the webhook processed the session and created exactly one attendee. */
export const expectProcessed = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(true);
  });
  expect((await getAttendeesRaw(listingId)).length).toBe(1);
};

export const expectReplayOutcome = async (
  session: Parameters<typeof runWebhook>[0],
  { processed, refundCalls }: { processed: boolean; refundCalls: number },
): Promise<void> => {
  await runWebhook(session, async (refund) => {
    await assertJson(webhookRequest(), 200, (json) => {
      expect(json.processed).toBe(processed);
    });
    expect(refund.calls.length).toBe(refundCalls);
  });
};

/**
 * Assert the webhook put the payment in front of the owner instead of acting
 * on it. The site cannot tell which figure is right when the charge and the
 * signed total disagree, so it refuses to move money by guesswork.
 */
export const expectOwnerAction = async (
  session: Parameters<typeof runWebhook>[0],
  listingId: number,
): Promise<void> => {
  await runWebhook(session, async (refund) => {
    await assertJson(webhookRequest(), 200, (json) => {
      expect(json.status).toBe("needs_action");
    });
    // No money moved on its own.
    expect(refund.calls.length).toBe(0);
  });
  // Nothing is booked while the owner decides, and the case is waiting.
  await expectNoAttendees(listingId);
  const { getOpenPaymentCases } = await import("#shared/db/payments/cases.ts");
  expect(await getOpenPaymentCases()).toHaveLength(1);
};
/** A package group whose single member has a base price of 5000 but a package
 * override of 1500. Returns the group and member. */
export const setupPackage = async () => {
  await setupStripe();
  const group = await createTestGroup({
    isPackage: true,
    name: "Pkg",
    slug: "pkg",
  });
  const listing = await createTestListing({
    groupId: group.id,
    maxAttendees: 50,
    unitPrice: 5000,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: listing.id, price: 1500 },
  ]);
  return { group, listing };
};

/** Signed metadata for a one-line package booking at `price` (the override).
 * The line carries its package edge (k:"p", r=group id), as the checkout emits. */
export const packageMetadata = (
  groupId: number,
  listingId: number,
  price: number,
) =>
  signMeta(
    webhookMeta({
      email: "buyer@example.com",
      items: JSON.stringify([
        { e: listingId, k: "p", p: price, q: 1, r: groupId },
      ]),
      name: "Buyer",
    }),
    price,
  );

/** Drive a 1500 package session through the webhook and assert it was kept as
 * a refunded placeholder (the post-checkout change invalidated the price). */
export const expectPackageRefund = (
  id: string,
  listingId: number,
  metadata: Record<string, string>,
): Promise<void> =>
  runWebhook({ amount_total: 1500, id, metadata }, async (refund) => {
    await expectStoredRefund(listingId);
    expect(refund.calls.length).toBe(1);
  });
