import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import { reconcilePayment } from "#shared/payment-runtime/process.ts";
import {
  createStoredSumupPayment,
  describeSumup,
  SUMUP_LOCAL_PAYMENT_ID,
  stubSumupProvider,
  sumupCheckoutResource,
} from "#test/shared/sumup/fixtures.ts";

describeSumup("SumUp callback attachment", () => {
  test("attaches a returned checkout id to its local checkout_reference", async () => {
    await createStoredSumupPayment(null);
    using _provider = stubSumupProvider();
    let fulfilledPaymentId = "";

    const outcome = await reconcilePayment(
      "sumup",
      { kind: "provider", resource: sumupCheckoutResource },
      (work) => {
        fulfilledPaymentId = work.payment.id;
        return Promise.resolve({
          attendee: { id: 42 },
          listingId: 7,
          success: true,
          ticketTokens: ["ticket-one"],
        });
      },
    );

    expect(outcome.status).toBe("fulfilled");
    expect(fulfilledPaymentId).toBe(SUMUP_LOCAL_PAYMENT_ID);
    const [stored] = await getPaymentSessions([SUMUP_LOCAL_PAYMENT_ID]);
    expect(stored?.session).toEqual(sumupCheckoutResource);
  });
});
