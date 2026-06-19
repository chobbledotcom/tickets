import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
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
 * The webhook trusts the agreed total the checkout signed into metadata (the
 * oracle the buyer paid, which the provider can't forge) and pages when its own
 * re-derivation disagrees. These tests drive every branch of that check through
 * the real webhook entrypoint: a faithful signed session succeeds; a tampered
 * signature, a charge that differs from the signed total, and a re-derivation
 * that diverges all refund. Unsigned metadata (plain webhookMeta) instead takes
 * the legacy re-derived fallback.
 */

/** Stub the Stripe provider to return a completed checkout session. */
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

const webhookRequest = () =>
  handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

describeWithEnv("webhook signed price oracle", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("a faithfully signed session is processed and creates the attendee", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const metadata = signMeta(
      webhookMeta({
        email: "ok@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Signed Buyer",
      }),
      1000,
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_signed_ok",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(true);
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    } finally {
      mockVerify.restore();
    }
  });

  test("a tampered signature is refunded and creates no attendee", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "tamper@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Tamper Buyer",
        }),
        1000,
      ),
      // A valid total but a wrong digest — as if the metadata were altered.
      price_proof: `1000.${"A".repeat(44)}`,
    };
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_signed_tampered",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
    }
  });

  test("a tampered signature whose refund fails returns 503 for retry", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // The signature gate refunds a tampered session, but the provider refund
    // fails. The webhook must return 5xx so the provider re-delivers and the
    // refund is re-attempted, not ack a customer who is still charged.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve(null),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "sigfail@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Sig Refund Fail",
        }),
        1000,
      ),
      price_proof: `1000.${"A".repeat(44)}`,
    };
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_sig_refund_fail",
      metadata,
    });
    try {
      const response = await webhookRequest();
      expect(response.status).toBe(503);
      expect(refund.calls.length).toBe(1);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
      refund.restore();
    }
  });

  test("a charge above the signed total is refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const metadata = signMeta(
      webhookMeta({
        email: "overcharge@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Overcharged Buyer",
      }),
      1000,
    );
    // Provider reports a charge that differs from the signed agreed total.
    const mockVerify = await stubCompletedSession({
      amount_total: 1200,
      id: "cs_signed_overcharge",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
    }
  });

  test("a re-derivation that diverges from the signed total is refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed (and charged) at 999, but the item re-prices to 1000 with no
    // modifiers in play — a re-derivation divergence, which refunds (a valid
    // proof pins the inputs, so this reflects a price edit, not a code bug).
    const metadata = signMeta(
      webhookMeta({
        email: "diverge@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Diverge Buyer",
      }),
      999,
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 999,
      id: "cs_signed_diverge",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
    }
  });

  test("a divergence from a dropped modifier ref is refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed at 1100 as if a +100 modifier applied, but the referenced modifier
    // no longer resolves, so re-derivation lands at 1000 — a legitimate change,
    // which refunds.
    const metadata = signMeta(
      webhookMeta({
        email: "dropped@example.com",
        items: singleItem(listing.id, 1, 1000),
        modifiers: JSON.stringify([{ i: 999999, q: 1 }]),
        name: "Dropped Buyer",
      }),
      1100,
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 1100,
      id: "cs_signed_dropped",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
    }
  });

  test("a signed session for a missing listing is refunded, not stranded", async () => {
    await setupStripe();
    // No listing with this id exists (as if deleted between checkout and the
    // webhook). The signature still proves the session is ours, so the 404 must
    // refund rather than take the foreign-session no-refund path that would
    // leave the customer charged.
    const metadata = signMeta(
      webhookMeta({
        email: "gone@example.com",
        items: singleItem(999999, 1, 1000),
        name: "Gone Buyer",
      }),
      1000,
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_missing_listing",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
    } finally {
      mockVerify.restore();
    }
  });

  test("a malformed price proof is rejected, not silently downgraded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // A present-but-corrupt proof must not fall back to the weaker unsigned
    // check (that would let tampering reinstate it); it refunds instead.
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_bad_total",
      metadata: {
        ...webhookMeta({
          email: "badtotal@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bad Total Buyer",
        }),
        price_proof: "not-a-number",
      },
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("price");
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
    }
  });

  test("a foreign-origin session is never refunded by the signature gate", async () => {
    await setupStripe();
    // A paid session from another instance sharing the provider, arriving on the
    // success-redirect path (which doesn't reject normal-session origins). Its
    // proof was signed with a different key (so it's invalid to us) and its
    // _origin isn't ours, so we must not refund another instance's payment.
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "foreign@example.com",
          items: singleItem(999999, 1, 1000),
          name: "Foreign Buyer",
        }),
        1000,
      ),
      _origin: "other-instance.example.test",
      price_proof: `1000.${"A".repeat(44)}`,
    };
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_should_not_happen" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_foreign",
        metadata,
        payment_intent: "pi_foreign",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_foreign"),
      );
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("a tampered signed field plus a tampered origin is rejected, not accepted via fallback", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed correctly, then a signed field (name) and _origin are both altered.
    // The re-derived price is unaffected by name and the charge matches, so the
    // old amount-only fallback would have ACCEPTED this. A present-but-invalid
    // proof must instead reject it: no attendee, and no refund (we can't prove
    // it is ours, and refunding could refund another instance's payment).
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "tamper-origin@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Real Name",
        }),
        1000,
      ),
      _origin: "other-instance.example.test",
      name: "Tampered Name",
    };
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_should_not_happen" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_tamper_origin",
        metadata,
        payment_intent: "pi_tamper_origin",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_tamper_origin"),
      );
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("an unsigned session still succeeds via the re-derived fallback", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Plain webhookMeta carries no signature, so the webhook falls back to
    // validating the charge against its re-derived total.
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_unsigned_ok",
      metadata: webhookMeta({
        email: "legacy@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Legacy Buyer",
      }),
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(true);
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    } finally {
      mockVerify.restore();
    }
  });

  test("a signed session whose _origin was stripped is still processed", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // _origin is unsigned, so stripping it after signing leaves a valid proof.
    // The proof alone proves the session is ours, so the webhook's foreign-origin
    // skip must not discard it.
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "stripped@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Origin Stripped",
        }),
        1000,
      ),
      _origin: "",
    };
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_origin_stripped",
      metadata,
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(true);
      });
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    } finally {
      mockVerify.restore();
    }
  });

  test("a corrupt-items signed session claiming our origin is refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed, then items corrupted: the proof is present but now invalid and the
    // items won't parse. A present proof means it came through our checkout, so
    // refund (like any invalid proof claiming our origin) rather than strand the
    // charged customer behind a bare error.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_corrupt_ours" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "corrupt@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Corrupt Ours",
        }),
        1000,
      ),
      items: "not-json",
    };
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_corrupt_ours",
      metadata,
    });
    try {
      const response = await webhookRequest();
      expect(response.status).toBe(200);
      expect(refund.calls.length).toBe(1);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
      refund.restore();
    }
  });

  test("an unsigned corrupt session is not refunded but fails loudly", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // No proof: this never came through our signed pipeline (a bug or a foreign
    // session), so it keeps the old loud failure and is not auto-refunded.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_never_unsigned" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_unsigned_corrupt",
      metadata: webhookMeta({
        email: "unsigned-corrupt@example.com",
        items: "not-json",
        name: "Unsigned Corrupt",
      }),
    });
    try {
      const response = await webhookRequest();
      expect(response.status).toBe(400);
      expect(refund.calls.length).toBe(0);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
      refund.restore();
    }
  });

  test("an unsigned foreign-origin webhook is ignored without refunding", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // No proof and an _origin that isn't ours: a different instance sharing the
    // provider. Skip it (ack) without processing or refunding its payment.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_never" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_foreign_unsigned",
      metadata: {
        ...webhookMeta({
          email: "foreign@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Foreign Unsigned",
        }),
        _origin: "other-instance.example.test",
      },
    });
    try {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.received).toBe(true);
      });
      expect(refund.calls.length).toBe(0);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
      refund.restore();
    }
  });

  test("a signed corrupt-shape session on the redirect path is refunded when ours", async () => {
    await setupStripe();
    // The success redirect reaches the same corrupt-session handling. Here the
    // items are a valid array with a malformed entry (missing price), which
    // throws inside parsing — the signed-ours path still refunds.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_corrupt_redirect" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "corruptredirect@example.com",
          items: singleItem(1, 1, 1000),
          name: "Corrupt Redirect",
        }),
        1000,
      ),
      items: JSON.stringify([{ e: 1, q: 1 }]),
    };
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_corrupt_redirect",
        metadata,
        payment_intent: "pi_corrupt_redirect",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_corrupt_redirect"),
      );
      expect(refund.calls.length).toBe(1);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("a signed corrupt session with a foreign origin is not refunded", async () => {
    await setupStripe();
    // A present proof but a foreign origin we can't match: even though it carries
    // a proof, we don't refund another instance's payment — surface the generic
    // error instead.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_never_redirect" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "corruptforeign@example.com",
          items: singleItem(1, 1, 1000),
          name: "Corrupt Foreign",
        }),
        1000,
      ),
      _origin: "other-instance.example.test",
      items: "not-json",
    };
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_corrupt_foreign",
        metadata,
        payment_intent: "pi_corrupt_foreign",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_corrupt_foreign"),
      );
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("a signed corrupt session whose refund fails returns 503 for retry", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // The provider refund fails (returns null): the event must NOT be
    // acknowledged as handled — return 503 so the provider re-delivers and the
    // refund is re-attempted, rather than leave the customer charged.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve(null),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "refundfail@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Refund Fail",
        }),
        1000,
      ),
      items: "not-json",
    };
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_refund_fail",
      metadata,
    });
    try {
      const response = await webhookRequest();
      expect(response.status).toBe(503);
      expect(refund.calls.length).toBe(1);
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    } finally {
      mockVerify.restore();
      refund.restore();
    }
  });

  test("a signed corrupt redirect whose refund fails shows contact-support", async () => {
    await setupStripe();
    // Refund fails on the redirect path too: show the contact-support message
    // rather than claim the payment was refunded.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve(null),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "refundfailredirect@example.com",
          items: singleItem(1, 1, 1000),
          name: "Refund Fail Redirect",
        }),
        1000,
      ),
      items: "not-json",
    };
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_refund_fail_redirect",
        metadata,
        payment_intent: "pi_refund_fail_redirect",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_refund_fail_redirect"),
      );
      expect(await response.text()).toContain("contact support");
      expect(refund.calls.length).toBe(1);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("a corrupt session already refunded by a prior delivery replays without re-refunding", async () => {
    await setupStripe();
    // Simulate the webhook having already claimed and refunded this session. The
    // success-redirect must replay "refunded" from the recorded outcome rather
    // than issue a second refund the provider would reject.
    await reserveSession("cs_replay_refunded");
    await markSessionFailed("cs_replay_refunded", {
      error: "Corrupt payment metadata; refunded.",
      refunded: true,
      status: 409,
    });
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_should_not_run" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "replay@example.com",
          items: singleItem(1, 1, 1000),
          name: "Replay Refunded",
        }),
        1000,
      ),
      items: "not-json",
    };
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_replay_refunded",
        metadata,
        payment_intent: "pi_replay",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_replay_refunded"),
      );
      expect(await response.text()).toContain("has been refunded");
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });

  test("a corrupt session claimed but not yet refunded replays as a retry", async () => {
    await setupStripe();
    // A concurrent delivery has claimed the session but not recorded a refund
    // yet: replay as not-refunded (contact-support) so the caller retries rather
    // than claiming success — and still no second refund is issued.
    await reserveSession("cs_replay_pending");
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_should_not_run" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const metadata = {
      ...signMeta(
        webhookMeta({
          email: "pending@example.com",
          items: singleItem(1, 1, 1000),
          name: "Replay Pending",
        }),
        1000,
      ),
      items: "not-json",
    };
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_replay_pending",
        metadata,
        payment_intent: "pi_pending",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_replay_pending"),
      );
      expect(await response.text()).toContain("contact support");
      expect(refund.calls.length).toBe(0);
    } finally {
      retrieve.restore();
      refund.restore();
    }
  });
});
