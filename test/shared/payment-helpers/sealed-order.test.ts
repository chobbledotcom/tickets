/** What a card provider stores for a checkout: a token, a listing, and a
 * proof. SumUp stages its own row, so its record is whole. The reading of a
 * sealed order is checked beside its reader, in
 * test/features/api/payment-processing/metadata/sealed-order.test.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { CARD_PROVIDERS, withProof } from "#test-utils/sealed-checkout.ts";

describeWithEnv("sealed checkout order", { db: true }, () => {
  for (const provider of CARD_PROVIDERS) {
    test(`${provider} stores only a token, the first listing, and a proof`, async () => {
      const { wire } = await withProof(
        checkoutIntent({
          items: [
            checkoutItem({ listingId: 7 }),
            checkoutItem({ listingId: 9 }),
          ],
          phone: "07700900000",
        }),
        provider,
      );

      expect(Object.keys(wire).toSorted()).toEqual([
        "_origin",
        "bundle",
        "listing",
        "price_proof",
      ]);
      expect(wire.listing).toBe("7");
      expect(JSON.stringify(wire)).not.toContain("07700900000");
      expect(JSON.stringify(wire)).not.toContain("buyer@example.com");
    });

    test(`${provider} proof covers the token and the listing`, async () => {
      const { metadata, total } = await withProof(checkoutIntent(), provider);
      const proof = parsePriceProof(metadata.price_proof)!;

      expect(proof.total).toBe(total);
      expect(await verifyPrice(metadata, proof.total, proof.sig)).toBe(true);
      for (const changed of [{ bundle: "other-token" }, { listing: "8" }]) {
        expect(
          await verifyPrice(
            { ...metadata, ...changed },
            proof.total,
            proof.sig,
          ),
        ).toBe(false);
      }
    });

    test(`${provider} gives each checkout its own token`, async () => {
      const first = await withProof(checkoutIntent(), provider);
      const second = await withProof(checkoutIntent(), provider);

      expect(first.metadata.bundle).not.toBe(second.metadata.bundle);
    });
  }

  test("sumup keeps the whole record, proof included, in its own staged row", async () => {
    const { metadata, total } = await withProof(
      checkoutIntent({
        phone: "07700900000",
        thankYouUrl: "https://example.com/thanks",
      }),
      "sumup",
    );
    const proof = parsePriceProof(metadata.price_proof)!;

    expect(metadata.bundle).toBe("");
    expect(metadata.phone).toBe("07700900000");
    expect(metadata.thank_you_url).toBe("https://example.com/thanks");
    expect(proof.total).toBe(total);
    expect(await verifyPrice(metadata, proof.total, proof.sig)).toBe(true);
  });

  test("hashes the renewal token before it rests anywhere", async () => {
    const { metadata } = await withProof(
      checkoutIntent({ siteToken: "plain-token-xyz" }),
      "sumup",
    );

    expect(metadata.site_token_index).toBe(await hmacHash("plain-token-xyz"));
    expect(JSON.stringify(metadata)).not.toContain("plain-token-xyz");
  });

  test("omits the renewal index when there is no renewal token", async () => {
    const { metadata } = await withProof(checkoutIntent(), "sumup");

    expect(metadata.site_token_index).toBe("");
  });
});
