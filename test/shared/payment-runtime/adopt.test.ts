import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentForFoundRead } from "#shared/payment-runtime/adopt.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import { stagedPaymentOwnership } from "#shared/payment-state/observation.ts";
import {
  foundRead,
  paymentObservation,
} from "#test/shared/payment-state/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createAggregatePayment } from "#test-utils/payment-aggregate.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { createLegacySumupCheckout } from "./fixtures.ts";

describeWithEnv(
  "matching a provider's answer to a payment we hold",
  { db: true },
  () => {
    test("refuses when the payment we put aside has gone", async () => {
      // We only stage a payment id after writing that payment down, so being
      // handed one we cannot find means a record went missing.
      const read = foundRead(
        paymentObservation({
          ownership: stagedPaymentOwnership("pay-vanished", "sess-vanished"),
        }),
      );

      await expect(paymentForFoundRead(read)).rejects.toThrow(
        "pay-vanished was not found",
      );
    });

    test("refuses an answer that came back from the wrong provider", async () => {
      // The payment was taken with Stripe, so a Square answer about it means
      // the two have been crossed somewhere and nothing here can be trusted.
      await setupStripe();
      await createAggregatePayment({
        charges: [{ amount: 100, reference: "ch-crossed" }],
        configuredAccount: true,
        paymentId: "pay-crossed",
        state: "created",
      });
      const read = foundRead(
        paymentObservation({
          ownership: stagedPaymentOwnership("pay-crossed", "sq-order"),
          session: PAYMENT_PROVIDER_RESOURCES.square.session("sq-order"),
        }),
      );

      await expect(paymentForFoundRead(read)).rejects.toThrow(
        "returned by the wrong provider",
      );
    });

    test("refuses to pick between two old records for the same checkout", async () => {
      // The payment was written down twice before the upgrade. Adopting one of
      // them would be a guess, so the owner is asked instead.
      const reference = "adopt-two-ways";
      await createLegacySumupCheckout(reference, "sumup-adopt", {
        filedUnder: "sumup",
      });
      await createLegacySumupCheckout(reference, "sumup-adopt", {
        filedUnder: "session",
      });
      const read = foundRead(
        paymentObservation({
          ownership: {
            localPaymentId: reference,
            method: "signed",
            signature: "signature-adopt",
          },
          session: PAYMENT_PROVIDER_RESOURCES.sumup.session("sumup-adopt"),
        }),
      );

      expect(await paymentForFoundRead(read)).toEqual({ conflict: true });
    });
  },
);
