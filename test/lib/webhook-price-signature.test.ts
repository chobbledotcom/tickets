import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
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
      // A valid-length but wrong digest — as if the metadata were altered.
      price_sig: "A".repeat(44),
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

  test("a re-derivation that diverges with inputs intact is refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed (and charged) at 999, but the item re-prices to 1000 with no
    // modifiers in play — a pure re-derivation divergence, which pages.
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

  test("a divergence from a dropped modifier ref is refunded without paging", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // Signed at 1100 as if a +100 modifier applied, but the referenced modifier
    // no longer resolves, so re-derivation lands at 1000. Because an input
    // dropped, this is a legitimate change rather than a code bug.
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

  test("a malformed price_total is treated as unsigned and falls back", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    // A non-numeric price_total can't be a trusted agreed total, so the webhook
    // ignores it and falls back to the re-derived check rather than refunding.
    const mockVerify = await stubCompletedSession({
      amount_total: 1000,
      id: "cs_bad_total",
      metadata: {
        ...webhookMeta({
          email: "badtotal@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bad Total Buyer",
        }),
        price_total: "not-a-number",
      },
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
});
