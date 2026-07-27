import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { locatePayment } from "#shared/payment-runtime/locate.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { required } from "#test-utils/required.ts";
import { createLegacySumupCheckout, createPendingPayment } from "./fixtures.ts";

describeWithEnv(
  "finding the payment a caller is asking about",
  { db: true },
  () => {
    afterEach(() => settings.clearTestOverrides());

    test("finds the payment behind a charge, not just behind a checkout", async () => {
      // A provider tells us about the charge; the payment is filed under the
      // checkout the charge belongs to.
      const payment = await createPendingPayment();
      const session = required(payment.session, "the payment's checkout");

      const located = await locatePayment("stripe", {
        kind: "provider",
        resource: {
          id: "ch_example",
          kind: "stripe_payment_intent",
          parentId: session.id,
          provider: "stripe",
        },
      });

      expect(located.payment?.id).toBe(payment.id);
      expect(located.requested).toMatchObject({ id: "ch_example" });
    });

    test("reports nothing found for a local id nobody knows", async () => {
      expect(
        await locatePayment("stripe", { id: "no-such-payment", kind: "local" }),
      ).toEqual({
        conflict: false,
        legacy: null,
        payment: null,
        requested: null,
      });
    });

    test("brings an old SumUp checkout forward when asked by its local id", async () => {
      await createLegacySumupCheckout(
        "legacy-locate-one",
        "sumup-checkout-one",
      );

      const located = await locatePayment("sumup", {
        id: "legacy-locate-one",
        kind: "local",
      });

      expect(located.payment?.id).toBe("legacy-locate-one");
      expect(located.requested).toMatchObject({ id: "sumup-checkout-one" });
    });
  },
);
