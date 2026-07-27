import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  locatePayment,
  matchLegacyPayment,
} from "#shared/payment-runtime/locate.ts";
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

    test("leaves a finished old SumUp payment as it is, and says where it was", async () => {
      // The buyer already paid before the upgrade, so there is nothing to
      // bring forward — the old record stands, named by its SumUp checkout.
      await createLegacySumupCheckout(
        "legacy-locate-two",
        "sumup-checkout-two",
        {
          finished: true,
        },
      );

      const located = await locatePayment("sumup", {
        id: "legacy-locate-two",
        kind: "local",
      });

      expect(located.payment).toBeNull();
      expect(located.legacy?.attendeeId).toBe(42);
      expect(located.legacy?.state).toBe("completed");
      expect(located.requested).toMatchObject({
        id: "sumup-checkout-two",
        kind: "sumup_checkout",
      });
    });

    test("refuses an old record the owner put with the wrong provider", async () => {
      // The owner assigned this old payment to Stripe, but the checkout it is
      // filed under is a SumUp one. One of the two is wrong, so we stop.
      const assignedToStripe: LegacyPaymentReplay = {
        accountId: "acct_1",
        attendeeId: null,
        id: "legacy:sumup:mismatched",
        mode: "live",
        provider: "stripe",
        revision: 1,
        runtime: {
          attendeePayment: null,
          checkoutStage: null,
          processedPayment: null,
          sumupCheckout: null,
        },
        state: "pending",
      };

      await expect(
        matchLegacyPayment(
          [assignedToStripe],
          PAYMENT_PROVIDER_RESOURCES.sumup.session("sumup-checkout-mismatch"),
        ),
      ).rejects.toThrow("belongs to stripe, not sumup");
    });

    test("refuses to pick between two old records for one payment", async () => {
      // The same payment was written down twice before the upgrade, so there
      // is no single old record to bring forward and the owner is asked.
      await createLegacySumupCheckout("legacy-locate-two-ways", "sumup-both", {
        filedUnder: "sumup",
      });
      await createLegacySumupCheckout("legacy-locate-two-ways", "sumup-both", {
        filedUnder: "session",
      });

      expect(
        await locatePayment("sumup", {
          id: "legacy-locate-two-ways",
          kind: "local",
        }),
      ).toEqual({
        conflict: true,
        legacy: null,
        payment: null,
        requested: null,
      });
    });
  },
);
