import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
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
 *  - mismatch (valid proof, charge != signed total): refunded.
 *  - ignore   (no valid proof — absent, malformed, tampered, or foreign):
 *             acknowledged without processing or refunding (we can't prove it is
 *             ours, and refunding an unverifiable session could refund another
 *             instance's payment).
 *
 * These tests drive every verdict through the real webhook/redirect entrypoints,
 * plus the two retry behaviours a failed refund depends on.
 */

/** Build signed metadata for a single-line ticket checkout. */
const signedMeta = (
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
const stubCompletedSession = async (object: {
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
const stubRetrievedSession = (object: {
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

const webhookRequest = () =>
  handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

const redirectRequest = (id: string) =>
  handleRequest(mockRequest(`/payment/success?session_id=${id}`));

/** Stub the provider refund to succeed (deterministic — no network). */
const stubRefundOk = () =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: "re_ok" } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

/** setupStripe + a 50-seat listing priced at 1000. */
const setupWithListing = async () => {
  await setupStripe();
  return createTestListing({ maxAttendees: 50, unitPrice: 1000 });
};

/** Drive a completed (paid) session through the webhook with a refund stub
 *  installed; `body` receives the refund spy. All stubs are restored after. */
const runWebhook = async (
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
const runFailedRefund = async (
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

/** Assert the webhook acknowledges (200) but refuses with a price error. */
const expectPriceRefusal = () =>
  assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(false);
    expect(json.error).toContain("price");
  });

/** Assert the webhook acknowledges (200) and silently ignores the session. */
const expectAcknowledgedIgnore = () =>
  assertJson(webhookRequest(), 200, (json) => {
    expect(json.received).toBe(true);
    expect(json.processed).toBeUndefined();
  });

/** Assert no attendee rows were created for the listing. */
const expectNoAttendees = async (listingId: number): Promise<void> => {
  expect((await getAttendeesRaw(listingId)).length).toBe(0);
};

/** Assert the webhook processed the session and created exactly one attendee. */
const expectProcessed = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(true);
  });
  expect((await getAttendeesRaw(listingId)).length).toBe(1);
};

describeWithEnv("webhook signed price oracle", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  // ---- trusted: process -----------------------------------------------------

  test("a faithfully signed session is processed and creates the attendee", async () => {
    const listing = await setupWithListing();
    await runWebhook(
      {
        id: "cs_signed_ok",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      },
      () => expectProcessed(listing.id),
    );
  });

  test("a signed session whose _origin was stripped is still processed", async () => {
    const listing = await setupWithListing();
    // _origin is unsigned, so stripping it after signing leaves a valid proof.
    // The proof alone proves the session is ours, regardless of the origin.
    const metadata = {
      ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      _origin: "",
    };
    await runWebhook({ id: "cs_origin_stripped", metadata }, () =>
      expectProcessed(listing.id),
    );
  });

  // ---- mismatch: refund -----------------------------------------------------

  test("a charge that differs from the signed total is refunded", async () => {
    const listing = await setupWithListing();
    // Signed at 1000 but the provider reports a 1200 charge — a mismatch.
    await runWebhook(
      {
        amount_total: 1200,
        id: "cs_signed_mismatch",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      },
      async (refund) => {
        await expectPriceRefusal();
        expect(refund.calls.length).toBe(1);
        await expectNoAttendees(listing.id);
      },
    );
  });

  // ---- trusted, but refunded by the downstream pricing checks ---------------

  test("a re-derivation that diverges from the signed total is refunded", async () => {
    const listing = await setupWithListing();
    // Signed and charged at 999, but the item re-prices to 1000 — a re-derivation
    // divergence, which refunds (the proof pins the inputs, so this reflects a
    // price edit between checkout and webhook, not a code bug).
    await runWebhook(
      {
        amount_total: 999,
        id: "cs_signed_diverge",
        metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
      },
      async () => {
        await expectPriceRefusal();
        await expectNoAttendees(listing.id);
      },
    );
  });

  test("a divergence from a dropped modifier ref is refunded", async () => {
    const listing = await setupWithListing();
    // Signed at 1100 as if a +100 modifier applied, but the referenced modifier
    // no longer resolves, so re-derivation lands at 1000 — refunds.
    const metadata = signedMeta(1100, {
      items: singleItem(listing.id, 1, 1000),
      modifiers: JSON.stringify([{ i: 999999, q: 1 }]),
    });
    await runWebhook(
      { amount_total: 1100, id: "cs_signed_dropped", metadata },
      async () => {
        await expectPriceRefusal();
        await expectNoAttendees(listing.id);
      },
    );
  });

  test("a signed session for a since-deleted listing is refunded, not stranded", async () => {
    await setupStripe();
    // No listing with this id exists (as if deleted between checkout and the
    // webhook). The proof still proves the session is ours, so the 404 must
    // refund rather than take the foreign-session no-refund path.
    await runWebhook(
      {
        id: "cs_missing_listing",
        metadata: signedMeta(1000, { items: singleItem(999999, 1, 1000) }),
      },
      async () => {
        await expectPriceRefusal();
      },
    );
  });

  // ---- ignore: acknowledge, never refund ------------------------------------

  test("a tampered proof is ignored without refunding", async () => {
    const listing = await setupWithListing();
    // A valid-looking total but a wrong digest — the proof no longer verifies.
    const metadata = {
      ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      price_proof: `1000.${"A".repeat(44)}`,
    };
    await runWebhook({ id: "cs_tampered", metadata }, async (refund) => {
      await expectAcknowledgedIgnore();
      expect(refund.calls.length).toBe(0);
      await expectNoAttendees(listing.id);
    });
  });

  test("a malformed price proof is ignored without refunding", async () => {
    const listing = await setupWithListing();
    const metadata = {
      ...webhookMeta({
        email: "badtotal@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Bad Total Buyer",
      }),
      price_proof: "not-a-number",
    };
    await runWebhook({ id: "cs_bad_total", metadata }, async (refund) => {
      await expectAcknowledgedIgnore();
      expect(refund.calls.length).toBe(0);
      await expectNoAttendees(listing.id);
    });
  });

  test("an unsigned session is ignored without refunding", async () => {
    const listing = await setupWithListing();
    // Plain webhookMeta carries no proof — there is no longer a re-derived
    // fallback, so without a proof we cannot prove the session is ours.
    const metadata = webhookMeta({
      email: "legacy@example.com",
      items: singleItem(listing.id, 1, 1000),
      name: "Legacy Buyer",
    });
    await runWebhook({ id: "cs_unsigned", metadata }, async (refund) => {
      await expectAcknowledgedIgnore();
      expect(refund.calls.length).toBe(0);
      await expectNoAttendees(listing.id);
    });
  });

  test("a session with corrupt items is ignored without parsing or refunding", async () => {
    const listing = await setupWithListing();
    // Signed, then items replaced with junk: the proof no longer verifies, so the
    // session is ignored before the items are ever parsed (no throw, no refund).
    const metadata = {
      ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      items: "not-json",
    };
    await runWebhook({ id: "cs_corrupt_items", metadata }, async (refund) => {
      await expectAcknowledgedIgnore();
      expect(refund.calls.length).toBe(0);
      await expectNoAttendees(listing.id);
    });
  });

  test("an unsigned foreign-origin webhook is ignored without refunding", async () => {
    const listing = await setupWithListing();
    // No proof and a foreign _origin: a different instance sharing the provider.
    const metadata = {
      ...webhookMeta({
        email: "foreign@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Foreign Unsigned",
      }),
      _origin: "other-instance.example.test",
    };
    await runWebhook(
      { id: "cs_foreign_unsigned", metadata },
      async (refund) => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.received).toBe(true);
        });
        expect(refund.calls.length).toBe(0);
        await expectNoAttendees(listing.id);
      },
    );
  });

  test("an unverifiable session on the redirect path is not recognized and not refunded", async () => {
    await setupStripe();
    // A paid session from another instance arriving on the success redirect: its
    // proof was signed with a different key (invalid to us), so we show the
    // not-recognized page and never refund another instance's payment.
    const metadata = {
      ...signedMeta(1000, { items: singleItem(999999, 1, 1000) }),
      _origin: "other-instance.example.test",
      price_proof: `1000.${"A".repeat(44)}`,
    };
    const refund = stubRefundOk();
    const retrieve = stubRetrievedSession({
      amount_total: 1000,
      id: "cs_foreign_redirect",
      metadata,
    });
    try {
      const response = await redirectRequest("cs_foreign_redirect");
      expect(await response.text()).toContain("not recognized");
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  // ---- failed-refund retry behaviour (the two review points) ----------------

  test("a mismatch whose refund fails returns 503 and the next delivery re-attempts it", async () => {
    const listing = await setupWithListing();
    // The provider refund keeps failing and the payment is not yet refunded. The
    // first delivery returns 503 AND releases the reservation, so the next
    // delivery re-claims and re-attempts the refund instead of colliding with the
    // lock and returning 409 until the row goes stale.
    await runFailedRefund(
      "cs_refund_retry",
      false,
      listing.id,
      async (refund) => {
        expect((await webhookRequest()).status).toBe(503);
        expect((await webhookRequest()).status).toBe(503);
        // Both deliveries re-attempted the refund — proof the reservation was
        // released rather than held until stale.
        expect(refund.calls.length).toBe(2);
        await expectNoAttendees(listing.id);
      },
    );
  });

  test("a mismatch whose refund reports failure but already settled is acknowledged", async () => {
    const listing = await setupWithListing();
    // The refund call returns null (e.g. the provider rejected a second full
    // refund), but the payment IS already fully refunded. That is success, not a
    // 503 retry loop: acknowledge and record the terminal outcome.
    await runFailedRefund(
      "cs_already_refunded",
      true,
      listing.id,
      async (refund) => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        expect(refund.calls.length).toBe(1);
        // Recorded as a terminal failure (refund settled), so a later delivery
        // replays it instead of retrying.
        const record = await isSessionProcessed("cs_already_refunded");
        expect(record?.failure_data).not.toBe("");
      },
    );
  });
});
