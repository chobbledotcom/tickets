import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  buildItemsMetadata,
  extractSessionMetadata,
  packMetadata,
  SQUARE_METADATA_MAX_ENTRIES,
  SQUARE_METADATA_MAX_VALUE_LENGTH,
  STRIPE_METADATA_MAX_VALUE_LENGTH,
} from "#shared/payment-helpers.ts";
import { verifyPrice } from "#shared/payment-signature.ts";
import type {
  BookingItem,
  CheckoutIntent,
  SessionMetadata,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils";

// hmacHash needs the encryption key configured, which describeWithEnv handles.
describeWithEnv(
  "buildItemsMetadata site-token hashing",
  { encryptionKey: true },
  () => {
    const baseIntent = (siteToken?: string): CheckoutIntent => ({
      address: "",
      date: null,
      email: "renew@example.com",
      items: [
        {
          listingId: 1,
          name: "Tier",
          quantity: 1,
          slug: "t",
          unitPrice: 0,
        },
      ],
      name: "Renewer",
      phone: "",
      special_instructions: "",
      ...(siteToken ? { siteToken } : {}),
    });

    test("emits site_token_index as the HMAC of the plain token", async () => {
      const metadata = await buildItemsMetadata(
        baseIntent("plain-token-xyz"),
        0,
        STRIPE_METADATA_MAX_VALUE_LENGTH,
      );
      const expected = await hmacHash("plain-token-xyz");
      // site_token_index is packed into `b` on the wire; the webhook recovers it
      // via extractSessionMetadata, so assert on that recovered value.
      expect(
        extractSessionMetadata(metadata as unknown as SessionMetadata)
          .site_token_index,
      ).toBe(expected);
    });

    test("plain token never appears in metadata", async () => {
      const metadata = await buildItemsMetadata(
        baseIntent("plain-token-xyz"),
        0,
        STRIPE_METADATA_MAX_VALUE_LENGTH,
      );
      for (const value of Object.values(metadata)) {
        expect(value.includes("plain-token-xyz")).toBe(false);
      }
    });

    test("omits site_token_index when siteToken is absent", async () => {
      const metadata = await buildItemsMetadata(
        baseIntent(),
        0,
        STRIPE_METADATA_MAX_VALUE_LENGTH,
      );
      expect("site_token_index" in metadata).toBe(false);
    });
  },
);

// The proof is signed over the logical metadata; Square then packs the small
// fields. This proves the webhook's unpack-then-verify reproduces the proof, and
// that tampering a packed field is still caught after the round-trip.
describeWithEnv(
  "buildItemsMetadata price proof survives packing",
  { encryptionKey: true },
  () => {
    const intent: CheckoutIntent = {
      address: "",
      date: "2026-07-01",
      email: "buyer@example.com",
      items: [
        { listingId: 1, name: "Tier", quantity: 2, slug: "t", unitPrice: 1000 },
      ],
      name: "Buyer",
      phone: "07700900000",
      special_instructions: "",
    };

    test("the signed proof verifies against the unpacked metadata", async () => {
      const total = priceCheckout(intent).total;
      // Apply the Square packing step over the signed metadata.
      const wire = packMetadata(
        await buildItemsMetadata(
          intent,
          total,
          SQUARE_METADATA_MAX_VALUE_LENGTH,
        ),
      );
      // Small fields (phone, date, …) are packed on the wire.
      expect("phone" in wire).toBe(false);
      expect(typeof wire.b).toBe("string");

      const extracted = extractSessionMetadata(
        wire as unknown as SessionMetadata,
      );
      const dot = extracted.price_proof.indexOf(".");
      const signedTotal = Number(extracted.price_proof.slice(0, dot));
      const sig = extracted.price_proof.slice(dot + 1);
      expect(signedTotal).toBe(total);
      expect(await verifyPrice(extracted, signedTotal, sig)).toBe(true);

      // Tampering a field that was packed-then-unpacked is still detected.
      expect(
        await verifyPrice(
          { ...extracted, phone: "07000000000" },
          signedTotal,
          sig,
        ),
      ).toBe(false);
    });
  },
);

// A folded paid parent's thank_you_url is capped/omitted
// BEFORE the metadata is signed, so the signed payload and the emitted metadata
// stay identical and the webhook never sees a tampered session for an honest
// over-cap URL.
describeWithEnv(
  "buildItemsMetadata caps thank_you_url before signing",
  { encryptionKey: true },
  () => {
    const intentWithUrl = (thankYouUrl: string): CheckoutIntent => ({
      address: "",
      date: "2026-07-01",
      email: "buyer@example.com",
      items: [
        { listingId: 1, name: "Base", quantity: 1, slug: "b", unitPrice: 1000 },
      ],
      name: "Buyer",
      phone: "",
      special_instructions: "",
      thankYouUrl,
    });

    const proofParts = (metadata: Record<string, string>) => {
      const proof = metadata.price_proof!;
      const dot = proof.indexOf(".");
      return {
        sig: proof.slice(dot + 1),
        total: Number(proof.slice(0, dot)),
      };
    };

    test("omits an over-cap URL and the proof still verifies (not tampered)", async () => {
      const longUrl = `https://example.com/${"x".repeat(
        SQUARE_METADATA_MAX_VALUE_LENGTH,
      )}`;
      const intent = intentWithUrl(longUrl);
      const total = priceCheckout(intent).total;
      const metadata = await buildItemsMetadata(
        intent,
        total,
        SQUARE_METADATA_MAX_VALUE_LENGTH,
      );
      // The over-cap URL is dropped from the emitted metadata...
      expect("thank_you_url" in metadata).toBe(false);
      // ...and the proof — signed over that same URL-less payload — verifies, so
      // the webhook classifies the session as legitimate, not tampered.
      const { sig, total: signedTotal } = proofParts(metadata);
      expect(
        await verifyPrice(
          extractSessionMetadata(metadata as unknown as SessionMetadata),
          signedTotal,
          sig,
        ),
      ).toBe(true);
    });

    test("omits a short URL that would exceed the provider entry cap, proof still verifies", async () => {
      // An order whose packed Square metadata already sits at the 10-entry cap
      // (4 base + packed `b` + address + special_instructions + answer_ids +
      // modifiers = 9, then + price_proof = 10) plus a *short* thank-you URL
      // would reach 11 entries — over Square's cap. The URL is the last-priority
      // optional field, so it is dropped before signing.
      const intent: CheckoutIntent = {
        address: "12 Some Street, Town",
        date: "2026-07-01",
        email: "buyer@example.com",
        items: [
          {
            listingId: 1,
            name: "Base",
            quantity: 1,
            slug: "b",
            unitPrice: 1000,
          },
        ],
        listingAnswerIds: { "1": [10, 20] },
        modifiers: [
          {
            id: 5,
            kind: "fixed",
            listingIds: null,
            name: "Extra",
            quantity: 1,
            trigger: "automatic",
            value: 500,
          },
        ],
        name: "Buyer",
        phone: "07700900000",
        special_instructions: "Leave at door",
        thankYouUrl: "https://example.com/thanks",
      };
      const total = priceCheckout(intent).total;
      const metadata = await buildItemsMetadata(
        intent,
        total,
        SQUARE_METADATA_MAX_VALUE_LENGTH,
        SQUARE_METADATA_MAX_ENTRIES,
      );
      // The short URL is dropped because keeping it would overflow the cap...
      expect("thank_you_url" in metadata).toBe(false);
      // ...and the wire (after Square packs the small fields) is within the cap.
      const wire = packMetadata(metadata);
      expect(Object.keys(wire).length).toBeLessThanOrEqual(
        SQUARE_METADATA_MAX_ENTRIES,
      );
      // The proof signed over the URL-less payload still verifies.
      const { sig, total: signedTotal } = proofParts(metadata);
      expect(
        await verifyPrice(
          extractSessionMetadata(wire as unknown as SessionMetadata),
          signedTotal,
          sig,
        ),
      ).toBe(true);
    });

    test("keeps a short URL under the entry cap when there is room", async () => {
      // A minimal order has plenty of entry headroom, so a short URL is kept
      // even under Square's tight 10-entry cap.
      const intent = intentWithUrl("https://example.com/thanks");
      const total = priceCheckout(intent).total;
      const metadata = await buildItemsMetadata(
        intent,
        total,
        SQUARE_METADATA_MAX_VALUE_LENGTH,
        SQUARE_METADATA_MAX_ENTRIES,
      );
      expect(metadata.thank_you_url).toBe("https://example.com/thanks");
    });

    test("carries a within-cap URL and the proof verifies with it present", async () => {
      const url = "https://example.com/thanks";
      const intent = intentWithUrl(url);
      const total = priceCheckout(intent).total;
      const metadata = await buildItemsMetadata(
        intent,
        total,
        SQUARE_METADATA_MAX_VALUE_LENGTH,
      );
      expect(metadata.thank_you_url).toBe(url);
      const { sig, total: signedTotal } = proofParts(metadata);
      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(extracted.thank_you_url).toBe(url);
      expect(await verifyPrice(extracted, signedTotal, sig)).toBe(true);
      // Stripe's larger cap also retains it.
      expect(
        (
          await buildItemsMetadata(
            intent,
            total,
            STRIPE_METADATA_MAX_VALUE_LENGTH,
          )
        ).thank_you_url,
      ).toBe(url);
    });
  },
);

describe("signed metadata budget", () => {
  test("a package order with a folded child fits Square's entry and value caps", async () => {
    const members = [11, 12, 13, 14, 15];
    const items: CheckoutIntent["items"] = [
      ...members.map((id) => ({
        listingId: id,
        name: `Member ${id}`,
        packageGroupId: 42,
        quantity: 2,
        slug: `m${id}`,
        unitPrice: 1234,
      })),
      { listingId: 91, name: "Child", quantity: 2, slug: "c", unitPrice: 0 },
    ];
    const intent: CheckoutIntent = {
      address: "12 Some Street, Townsville",
      allocations: [{ childId: 91, parentId: 11, qty: 2 }],
      date: "2026-08-01",
      dayCount: 3,
      email: "buyer@example.com",
      items,
      listingAnswerIds: { "11": [1, 2], "12": [3] },
      name: "Buyer Person",
      phone: "+441234567890",
      reservationAmount: "10%",
      special_instructions: "Leave at the front desk",
    };
    const metadata = await buildItemsMetadata(
      intent,
      priceCheckout(intent).total,
      SQUARE_METADATA_MAX_VALUE_LENGTH,
      SQUARE_METADATA_MAX_ENTRIES,
    );
    // The wire shape (Square packs the small fields into `b`) must fit both caps
    // even with the per-line edge tags and the allocations map present.
    const wire = packMetadata(metadata);
    expect(Object.keys(wire).length).toBeLessThanOrEqual(
      SQUARE_METADATA_MAX_ENTRIES,
    );
    for (const value of Object.values(wire)) {
      expect(value.length).toBeLessThanOrEqual(
        SQUARE_METADATA_MAX_VALUE_LENGTH,
      );
    }
    // Package members carry the compact edge tag; the folded child stays untagged.
    const lines = JSON.parse(wire.items ?? "[]") as BookingItem[];
    expect(lines.find((l) => l.e === 11)).toEqual({
      e: 11,
      k: "p",
      p: 2468,
      q: 2,
      r: 42,
    });
    expect(lines.find((l) => l.e === 91)).toEqual({ e: 91, p: 0, q: 2 });
  });
});
