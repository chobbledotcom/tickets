import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  stripeClient,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";

describeWithEnv("Stripe subscription cancel", { db: true }, () => {
  test("asks Stripe to cancel the subscription and reads its answer", async () => {
    const ended = stripeSubscription({ id: "sub_1", status: "canceled" });
    const client = await stripeClient();
    const cancel = stub(client.subscriptions, "cancel", () =>
      Promise.resolve(ended),
    );
    try {
      expect(await stripeApi.cancelSubscription("sub_1")).toEqual({
        resource: ended,
        status: "found",
      });
      expect(cancel.calls.map((call) => call.args)).toEqual([["sub_1"]]);
    } finally {
      cancel.restore();
    }
  });
});
