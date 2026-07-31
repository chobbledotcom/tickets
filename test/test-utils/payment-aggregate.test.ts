import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createAggregatePayment,
  getPaymentAggregate,
} from "#test-utils/payment-aggregate.ts";

const balanceIntent = (attendeeId: number) => ({
  address: "",
  balanceAttendeeId: attendeeId,
  date: null,
  email: "balance@example.com",
  items: [{ e: 1, p: 500, q: 1 }],
  modifiers: [],
  name: "Balance payment",
  phone: "",
  special_instructions: "",
});

describeWithEnv("the payment fixture builder", { db: true }, () => {
  test("finishes a payment towards a balance as a balance booking", async () => {
    // The stored record refuses to say "registration" about a payment that
    // names an attendee to settle up, so a fixture that got this wrong could
    // not be written down at all.
    const fixture = await createAggregatePayment({
      attendeeId: 7,
      bookingIntent: balanceIntent(7),
      charges: [{ amount: 500, reference: "pi_balance_fixture" }],
      paymentId: "pay_balance_fixture",
    });

    const stored = await getPaymentAggregate(fixture.payment.id);
    expect(stored.completion).toMatchObject({
      facts: { flow: "balance", listingId: 1 },
      kind: "booking",
    });
  });

  test("finishes an ordinary payment as a registration booking", async () => {
    const fixture = await createAggregatePayment({
      attendeeId: 8,
      charges: [{ amount: 500, reference: "pi_registration_fixture" }],
      paymentId: "pay_registration_fixture",
    });

    const stored = await getPaymentAggregate(fixture.payment.id);
    expect(stored.completion).toMatchObject({
      facts: { flow: "registration" },
      kind: "booking",
    });
  });
});
