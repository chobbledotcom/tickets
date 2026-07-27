import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { signBalanceToken } from "#shared/balance-link.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createReserved,
  insertBareAttendee,
  postPay,
} from "#test/integration/balance-helpers.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCsrfToken } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("server (public balance page) > POST", { db: true }, () => {
  test("POST refuses a reservation with no real booking line", async () => {
    await setupStripe();
    const reservation = await attendeeStatuses.table.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
    });
    // No quantity > 0 line means nothing real to pay into, so the balance is not
    // publicly payable — checkout must not start against a phantom listing.
    const attendeeId = await insertBareAttendee(reservation.id, 1500);
    const token = await signBalanceToken(attendeeId);
    const response = await postPay(token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no tickets to pay for");
  });

  test("POST rejects an invalid csrf token", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "invalid" }, ""),
    );
    expect(await response.text()).toContain("not valid");
  });

  test("POST starts a checkout for the balance", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(
        `/pay/${token}`,
        { csrf_token: await testCsrfToken() },
        "",
      ),
    );
    // Redirects to the hosted checkout (302/303) on success.
    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toContain("http");
  });

  test("POST builds a fee-free balance checkout intent for the outstanding amount", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500, {
      listingName: "Workshop Ticket",
      quantity: 2,
    });
    const token = await signBalanceToken(attendeeId);
    // Capture the intent the balance POST hands the provider, then stop the flow.
    let captured: PaymentCheckoutCreateSnapshot | undefined;
    const checkoutStub = stub(
      stripePaymentProvider,
      "createCheckout",
      (checkout) => {
        captured = checkout;
        return Promise.resolve({ error: "captured" });
      },
    );
    try {
      await postPay(token);
    } finally {
      checkoutStub.restore();
    }
    // A single "Remaining balance" line at the outstanding amount, no booking
    // fee, no PII — the exact contract the customer is charged against.
    expect(captured?.bookingIntent).toEqual({
      address: "",
      balanceAttendeeId: attendeeId,
      date: null,
      email: "",
      items: [{ e: listingId, p: 1500, q: 1 }],
      modifiers: [],
      name: "Balance payment",
      phone: "",
      special_instructions: "",
    });
    expect(captured?.expected).toEqual({ amount: 1500, currency: "GBP" });
    expect(captured?.order).toEqual({
      extras: [],
      lines: [{ amount: 1500, name: "Remaining balance", quantity: 1 }],
    });
  });

  test("POST rejects an invalid CSRF token before checkout", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "wrong-token" }, ""),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not valid");
  });

  test("POST shows an error when no payment provider is configured", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await postPay(token);
    expect(await response.text()).toContain("not valid");
  });

  test("POST rejects an invalid CSRF token before checking the balance", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "bad-token" }, ""),
    );
    expect(await response.text()).toContain("not valid");
  });

  test("POST shows an error when the checkout cannot be created", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const checkoutStub = stub(stripePaymentProvider, "createCheckout", () =>
      Promise.resolve({ error: "boom" }),
    );
    try {
      const response = await postPay(token);
      expect(await response.text()).toContain("not valid");
    } finally {
      checkoutStub.restore();
    }
  });
});
