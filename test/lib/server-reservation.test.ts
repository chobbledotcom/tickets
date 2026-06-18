import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  getPublicDefaultStatus,
  invalidateAttendeeStatusesCache,
} from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createTestListing,
  describeWithEnv,
  mockRequest,
  setupStripe,
  submitTicketForm,
} from "#test-utils";

/** Turn the seeded public-default status into a reservation charging `amount`. */
const setPublicReservation = async (amount: string): Promise<number> => {
  await getDb().execute({
    args: [amount],
    sql: "UPDATE attendee_statuses SET is_reservation = 1, reservation_amount = ? WHERE is_public_default = 1",
  });
  invalidateAttendeeStatusesCache();
  const status = await getPublicDefaultStatus();
  return status!.id;
};

/** Stub a paid Stripe checkout session with the given metadata and total. */
const stubPaidSession = (
  id: string,
  metadata: Record<string, string>,
  amountTotal: number,
) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: amountTotal,
      id,
      metadata,
      payment_intent: `pi_${id}`,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

/** The most recently created attendee's plaintext reservation columns. */
const latestAttendee = async (): Promise<{
  id: number;
  statusId: number | null;
  remainingBalance: number;
  pricePaid: number;
}> => {
  const { rows } = await getDb().execute(
    "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
  );
  const id = Number(rows[0]!.id);
  const state = await getAttendeeBalanceState(id);
  const paid = await getDb().execute({
    args: [id],
    sql: "SELECT price_paid FROM listing_attendees WHERE attendee_id = ?",
  });
  return {
    id,
    pricePaid: Number(paid.rows[0]!.price_paid),
    remainingBalance: state!.remainingBalance,
    statusId: state!.statusId,
  };
};

describeWithEnv(
  "server (reservation deposit at checkout)",
  { db: true },
  () => {
    afterEach(() => resetStripeClient());

    test("books a reserved attendee owing the balance after the deposit", async () => {
      await setupStripe();
      await settings.update.bookingFee("10");
      const statusId = await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      // Full £10.00, deposit 10% = £1.00, fee 10% of the full £10.00 = £1.00.
      const session = stubPaidSession(
        "cs_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        200,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dep"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        // Paid the £1.00 deposit; the remaining £9.00 is owed.
        expect(attendee.pricePaid).toBe(100);
        expect(attendee.remainingBalance).toBe(900);
        // The booking starts in the public-default reservation status.
        expect(attendee.statusId).toBe(statusId);
      } finally {
        session.restore();
      }
    });

    test("recomputes flat split deposits exactly when storing the remaining balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const session = stubPaidSession(
        "cs_flat_split",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 3000, q: 3 }]),
          name: "Reserver",
          reservation_amount: "10",
        },
        1000,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_flat_split"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.pricePaid).toBe(1000);
        expect(attendee.remainingBalance).toBe(2000);
      } finally {
        session.restore();
      }
    });

    test("refunds when the charged total does not match deposit plus fee", async () => {
      await setupStripe();
      await settings.update.bookingFee("10");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_1" } as never),
      );
      // Expected total is 200 (deposit 100 + fee 100); charge a wrong 150.
      const session = stubPaidSession(
        "cs_bad",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        150,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad"),
        );
        // Price mismatch → 409 and no attendee is created.
        expect(response.status).toBe(409);
        const { rows } = await getDb().execute(
          "SELECT COUNT(*) AS c FROM attendees",
        );
        expect(Number(rows[0]!.c)).toBe(0);
      } finally {
        session.restore();
        refund.restore();
      }
    });

    test("a reservation public-default carries the deposit amount into checkout", async () => {
      await setupStripe();
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      let captured: CheckoutIntent | undefined;
      const checkout = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.example/checkout",
            sessionId: "cs_test",
          });
        },
      );
      try {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "buyer@example.com",
          name: "Buyer",
        });
        expect([302, 303]).toContain(response.status);
        // Items keep their full price; the snapshot tells the provider/webhook to
        // charge and reconcile a 10% deposit.
        expect(captured?.reservationAmount).toBe("10%");
        expect(captured?.items[0]?.unitPrice).toBe(1000);
      } finally {
        checkout.restore();
      }
    });

    test("a non-reservation public-default carries no deposit amount", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      let captured: CheckoutIntent | undefined;
      const checkout = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.example/checkout",
            sessionId: "cs_test",
          });
        },
      );
      try {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "buyer@example.com",
          name: "Buyer",
        });
        expect([302, 303]).toContain(response.status);
        // The seeded default is a full-payment status, so no deposit snapshot.
        expect(captured?.reservationAmount).toBeUndefined();
      } finally {
        checkout.restore();
      }
    });

    test("carries resolved modifiers into a full-payment checkout", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "Service charge",
      });
      let captured: CheckoutIntent | undefined;
      const checkout = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.example/checkout",
            sessionId: "cs_test",
          });
        },
      );
      try {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "buyer@example.com",
          name: "Buyer",
        });
        expect([302, 303]).toContain(response.status);
        expect(captured?.modifiers).toHaveLength(1);
        expect(captured?.modifiers?.[0]?.value).toBe(10);
      } finally {
        checkout.restore();
      }
    });

    test("carries no deposit when no public-default status is configured", async () => {
      await setupStripe();
      // Clear the public-default flag so getPublicDefaultStatus returns null.
      await getDb().execute(
        "UPDATE attendee_statuses SET is_public_default = 0",
      );
      invalidateAttendeeStatusesCache();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      let captured: CheckoutIntent | undefined;
      const checkout = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.example/checkout",
            sessionId: "cs_test",
          });
        },
      );
      try {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "buyer@example.com",
          name: "Buyer",
        });
        expect([302, 303]).toContain(response.status);
        expect(captured?.reservationAmount).toBeUndefined();
      } finally {
        checkout.restore();
      }
    });

    test("charges no deposit when the amount is zero, leaving the full balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("10");
      await setPublicReservation("0");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      // Deposit £0.00, fee 10% of the full £10.00 = £1.00 → total 100.
      const session = stubPaidSession(
        "cs_zero",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "0",
        },
        100,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_zero"),
        );
        expect([200, 302, 303]).toContain(response.status);
        const attendee = await latestAttendee();
        expect(attendee.pricePaid).toBe(0);
        expect(attendee.remainingBalance).toBe(1000);
      } finally {
        session.restore();
      }
    });
  },
);
