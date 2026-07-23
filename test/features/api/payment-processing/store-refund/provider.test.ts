/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { queryAll } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  intentFor,
  paidSession,
  stageSession,
} from "#test/features/api/payment-processing/staged-runtime.helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

/* jscpd:ignore-end */

describeWithEnv("staged refund provider", { db: true }, () => {
  test("uses the provider stored on the stage after the active provider changes", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("stored-provider", intent);
    await deactivateTestListing(listing.id);
    await settings.update.paymentProvider("square");
    using stripeRefund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded" as const),
    );
    using squareRefund = stub(squarePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded" as const),
    );

    const result = await processPaymentSession(
      "stored-provider",
      paidSession("stored-provider", intent),
    );

    expect(result).toMatchObject({ refundStatus: "refunded", success: false });
    expect(stripeRefund.calls.map((call) => call.args)).toEqual([
      ["payment-stored-provider"],
    ]);
    expect(squareRefund.calls).toHaveLength(0);
  });

  test("resumes an uncertain SumUp refund by status without a second POST", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("sumup-uncertain", intent, "sumup");
    await deactivateTestListing(listing.id);
    using refund = stub(sumupApi, "refundTransaction", () =>
      Promise.resolve(true),
    );
    let statusReads = 0;
    using status = stub(sumupApi, "getTransactionStatus", () =>
      Promise.resolve(++statusReads === 1 ? null : "REFUNDED"),
    );

    expect(
      await processPaymentSession(
        "sumup-uncertain",
        paidSession("sumup-uncertain", intent),
      ),
    ).toMatchObject({ refundStatus: "pending", success: false });
    expect(
      await queryAll(
        "SELECT provider FROM payment_refund_attempts ORDER BY provider",
      ),
    ).toEqual([{ provider: "sumup" }]);
    expect(
      await processPaymentSession(
        "sumup-uncertain",
        paidSession("sumup-uncertain", intent),
      ),
    ).toMatchObject({ refundStatus: "refunded", success: false });
    expect(refund.calls).toHaveLength(1);
    expect(status.calls.map((call) => call.args)).toEqual([
      ["payment-sumup-uncertain"],
      ["payment-sumup-uncertain"],
    ]);
    expect(
      await queryAll("SELECT memo FROM transfers WHERE kind = 'refund_cash'"),
    ).toEqual([{ memo: "registration_closed" }]);
  });
});
