import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
import {
  assembleCheckoutMetadata,
  buildMetadata,
  extractSessionMetadata,
} from "#shared/payment-helpers.ts";
import {
  parsePriceProof,
  signPrice,
  verifyPrice,
} from "#shared/payment-signature.ts";
import { NO_TAX, type TaxPolicy } from "#shared/tax/types.ts";
import { checkoutIntent } from "#test-utils/checkout-items.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";
import { testWithSetting } from "#test-utils/settings.ts";

const policy: TaxPolicy = { mode: "add_to_total", rateBasisPoints: 1725 };

describe("signed VAT metadata", () => {
  for (const provider of ["stripe", "square", "sumup"] as const) {
    testWithSetting(
      `${provider} carries the frozen policy through its wire format`,
      { booking_fee: "0" },
      async () => {
        const wire = await assembleCheckoutMetadata(
          provider,
          checkoutIntent({ taxPolicy: policy }),
          1173,
        );
        if (provider === "square") {
          expect(Object.keys(wire).length).toBeLessThanOrEqual(10);
          expect(
            Object.values(wire).every((value) => value.length <= 255),
          ).toBe(true);
          expect(wire.tax_policy).toBeUndefined();
          expect(wire.b).toContain("tax_policy");
        }
        const metadata = extractSessionMetadata(wireMetadata(wire));
        expect(extractIntentFromMetadata(metadata)?.taxPolicy).toEqual(policy);
        const proof = parsePriceProof(metadata.price_proof)!;
        expect(await verifyPrice(metadata, proof.total, proof.sig)).toBe(true);
        expect(
          await verifyPrice(
            { ...metadata, tax_policy: JSON.stringify(NO_TAX) },
            proof.total,
            proof.sig,
          ),
        ).toBe(false);
      },
    );
  }
  testWithSetting(
    "an old signed session without VAT remains valid and explicitly untaxed",
    { booking_fee: "0" },
    async () => {
      const old = buildMetadata({
        date: null,
        email: "buyer@example.com",
        items: [{ e: 1, p: 1000, q: 1 }],
        name: "Buyer",
      });
      const signature = signPrice(old, 1000);
      const metadata = extractSessionMetadata(
        wireMetadata({ ...old, price_proof: `1000.${signature}` }),
      );
      expect(await verifyPrice(metadata, 1000, signature)).toBe(true);
      expect(extractIntentFromMetadata(metadata)?.taxPolicy).toEqual(NO_TAX);
    },
  );
});
