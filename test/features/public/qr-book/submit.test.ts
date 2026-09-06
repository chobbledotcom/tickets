import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toMinorUnits } from "#shared/currency.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeesRaw } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { expectStripeCheckoutAtPrice, withStripe } from "./helpers.ts";

describeWithEnv("QR booking submission", { db: true }, () => {
  describe("price override", () => {
    test("uses the signed price for a fixed-price listing", async () => {
      await setupStripe();
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const overridePrice = toMinorUnits(12.5);
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", value: overridePrice }),
      );
      await withStripe(async (stripe) => {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: token,
        });
        expectStripeCheckoutAtPrice(response, stripe, overridePrice);
      });
    });

    test("ignores a changed token and uses the stored price", async () => {
      await setupStripe();
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await withStripe(async (stripe) => {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: "qr1.forged.signature",
        });
        expectStripeCheckoutAtPrice(response, stripe, 500);
      });
    });

    test("keeps the free booking path available without a token", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 0,
      });
      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "ada@example.com",
        name: "Ada",
      });

      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });
  });
});
