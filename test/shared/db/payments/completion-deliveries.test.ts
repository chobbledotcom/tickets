import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#shared/db/client.ts";
import { requirePaymentSessionClaim } from "#shared/db/payments/claims.ts";
import {
  completePaymentCompletionDelivery,
  getPaymentCompletionDeliveriesByKeys,
  getPendingPaymentCompletionDeliveries,
  storePaymentCompletionDeliveries,
} from "#shared/db/payments/completion-deliveries.ts";
import type { PreparedPaymentCompletionDelivery } from "#shared/payment-completion-delivery.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { PAYMENT_ID } from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { required } from "#test-utils/required.ts";

const webhookDelivery: PreparedPaymentCompletionDelivery = {
  data: {
    kind: "registration_webhook",
    listingId: 7,
    payload: {
      address: "",
      amount_owed: 0,
      business_email: "",
      currency: "GBP",
      email: "buyer@example.com",
      name: "Buyer",
      notification_type: "registration.completed",
      payment_id: PAYMENT_ID,
      phone: "",
      price_paid: 100,
      special_instructions: "",
      ticket_url: "https://tickets.example.com/t/one",
      tickets: [],
      timestamp: "2026-07-26T12:00:00.000Z",
    },
    url: "https://hooks.example.com/register",
  },
  key: "registration-webhook",
};

const storedDelivery = async (): Promise<number> => {
  await createPendingPayment();
  await withTransaction((transaction) =>
    storePaymentCompletionDeliveries(transaction, PAYMENT_ID, [
      webhookDelivery,
    ]),
  );
  const [pending] = await getPendingPaymentCompletionDeliveries(PAYMENT_ID);
  return required(pending, "the stored delivery").id;
};

describeWithEnv("db > payments > completion deliveries", { db: true }, () => {
  test("asks the database nothing when no deliveries were named", async () => {
    await createPendingPayment();

    const answered = await runWithSubrequestBudget(async () => {
      const deliveries = await getPaymentCompletionDeliveriesByKeys(
        PAYMENT_ID,
        [],
      );
      return { deliveries, used: getSubrequestUsage().database };
    });

    expect(answered.deliveries).toEqual([]);
    // Reading nothing costs nothing: the edge runtime only allows so many
    // database calls per request, so an empty list must not spend one.
    expect(answered.used).toBe(0);
  });

  test("refuses to finish a delivery that is already finished", async () => {
    // Two runs of the same work must not both count it as done — the second
    // finds nothing left to change and says so rather than carrying on.
    const deliveryId = await storedDelivery();
    const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
    await completePaymentCompletionDelivery(claim, deliveryId);

    await expect(
      completePaymentCompletionDelivery(claim, deliveryId),
    ).rejects.toThrow(`Payment completion delivery ${deliveryId} changed`);
  });
});
