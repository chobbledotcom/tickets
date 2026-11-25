/** A paid subscription checkout whose sealed order is gone. The site cannot
 * book the buyer, and the subscription keeps charging, so the note on the
 * listing names the subscription. A refund of the payment does not stop it. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkoutListingId,
  deliver,
  SUBSCRIPTION_ID,
  startedCheckout,
} from "#test/integration/server/webhooks/subscription-refund-helpers.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { adminGet } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { withSubscriptionStarted } from "#test-utils/stripe/subscription-checkout.ts";

describeWithEnv(
  "a lost order that started a subscription",
  { db: true },
  () => {
    test("is reported with its subscription, and the note says that a refund does not stop it", async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      const started = startedCheckout(listingId);
      started.session.metadata = signedMeta(
        { bundle: "no_such_token", listing: String(listingId), name: "Member" },
        2000,
      );

      await withSubscriptionStarted(started, async () => {
        expect((await deliver()).status).toBe(503);
      });

      const page = await adminGet(`/admin/listing/${listingId}`);
      expectIncludesAll(await page.text(), [
        `The subscription is ${SUBSCRIPTION_ID}.`,
        "The subscription will keep charging, even if you refund this payment.",
      ]);
    });
  },
);
