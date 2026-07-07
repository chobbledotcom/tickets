import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { getNoteRows } from "#shared/db/system-notes.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestGroup,
  createTestListing,
  mockRequest,
  mockWebhookRequest,
  setupStripe,
  signMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

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
}) => {
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  return stub(stripePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({
      listing: {
        data: {
          object: {
            ...object,
            payment_intent: `pi_${object.id}`,
            payment_status: "paid",
          },
        },
        id: `evt_${object.id}`,
        type: "checkout.session.completed",
      },
      valid: true as const,
    }),
  );
};

/** Stub the redirect path's session retrieval for a paid session. */
export const stubRetrievedSession = (object: {
  amount_total: number;
  id: string;
  metadata: Record<string, string>;
}) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      ...object,
      payment_intent: `pi_${object.id}`,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

export const webhookRequest = () =>
  handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

export const redirectRequest = (id: string) =>
  handleRequest(mockRequest(`/payment/success?session_id=${id}`));

/** Stub the provider refund to succeed (deterministic — no network). */
export const stubRefundOk = () =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: "re_ok" } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
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
  const refund = stub(stripeApi, "refundPayment", () => Promise.resolve(null));
  const intent = stub(stripeApi, "retrievePaymentIntent", () =>
    Promise.resolve({
      latest_charge: { refunded: intentRefunded },
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrievePaymentIntent>
    >),
  );
  const mockVerify = await stubCompletedSession({
    amount_total: 1200,
    id,
    metadata: signedMeta(1000, { items: singleItem(listingId, 1, 1000) }),
  });
  try {
    await body(refund);
  } finally {
    mockVerify.restore();
    intent.restore();
    refund.restore();
  }
};

/** Assert the webhook kept the booking as a quantity-0 placeholder (with a system
 *  note) and refused with the generic "saved your details" message. */
export const expectStoredRefundRecord = async (
  listingId: number,
): Promise<void> => {
  const [attendee] = await getAttendeesRaw(listingId);
  expect(attendee?.quantity).toBe(0);
  expect(await getNoteRows([attendee!.id])).toHaveLength(1);
};

export const expectStoredRefund = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(false);
    expect(json.error).toContain("saved your details");
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
