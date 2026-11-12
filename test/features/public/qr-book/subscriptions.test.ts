import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { listingsTable } from "#db/listings/records.ts";
import { t } from "#i18n";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enableFeature, setupStripe } from "#test-utils/settings.ts";
import {
  stripeCheckoutSession,
  stripeClient,
} from "#test-utils/stripe/fixtures.ts";
import { scanRequest } from "./helpers.ts";

describeWithEnv("subscription QR checkout", { db: true }, () => {
  for (const value of [0, 1000]) {
    test(
      value === 0
        ? "refuses a signed zero subscription value before contacting Stripe"
        : "starts a nonzero subscription QR checkout through the real provider",
      async () => {
        await setupStripe();
        await enableFeature("subscriptions");
        const listing = await createTestListing({
          fields: "",
          maxAttendees: 10,
          unitPrice: 1000,
        });
        await listingsTable.update(listing.id, {
          recurringInterval: "month",
          recurringPrice: 500,
        });
        const client = await stripeClient();
        using create = stub(client.checkout.sessions, "create", () =>
          Promise.resolve(stripeCheckoutSession()),
        );
        const response = await scanRequest(listing, { name: "Ada", value });

        if (value === 0) {
          expect(response.status).toBe(400);
          expect(create.calls.length).toBe(0);
          expectIncludesAll(await response.text(), [
            t("payment.error.subscription_free"),
            `/ticket/${listing.slug}`,
          ]);
        } else {
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe(
            "https://checkout.stripe.com/c/pay/cs_test",
          );
          expect(create.calls.length).toBe(1);
          const asked = create.calls[0]!.args[0];
          expect(asked.mode).toBe("subscription");
          expect(
            asked.line_items.map(({ price_data, quantity }) => ({
              amount: price_data.unit_amount,
              interval: price_data.recurring?.interval,
              quantity,
            })),
          ).toEqual([
            { amount: 1000, interval: undefined, quantity: 1 },
            { amount: 500, interval: "month", quantity: 1 },
          ]);
        }
      },
    );
  }
});
