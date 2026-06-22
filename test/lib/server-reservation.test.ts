import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { signBalanceToken } from "#shared/balance-link.ts";
import {
  getPublicDefaultStatus,
  invalidateAttendeeStatusesCache,
} from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
} from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import {
  hashEmail,
  recordBooking,
  recordVisit,
} from "#shared/db/contact-preferences.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createTestListing,
  describeWithEnv,
  expectFlash,
  mockRequest,
  setupStripe,
  signMeta,
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

/** Stub a paid Stripe checkout session with the given metadata and total. The
 * metadata is signed at `amountTotal` (as production checkout does) so the
 * session classifies as trusted — an unsigned session would now be ignored. */
const stubPaidSession = (
  id: string,
  metadata: Record<string, string>,
  amountTotal: number,
) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: amountTotal,
      id,
      metadata: signMeta(metadata, amountTotal),
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

const attendeeCount = async (): Promise<number> => {
  const { rows } = await getDb().execute("SELECT COUNT(*) AS c FROM attendees");
  return Number(rows[0]!.c);
};

const modifierUsageCount = async (modifierId: number): Promise<number> => {
  const { rows } = await getDb().execute({
    args: [modifierId],
    sql: "SELECT COALESCE(SUM(quantity), 0) AS c FROM modifier_usages WHERE modifier_id = ?",
  });
  return Number(rows[0]!.c);
};

/** Create a listing plus a one-unit, stock-limited discount modifier whose unit
 * is consumed by a concurrent order — simulated with an AFTER INSERT trigger on
 * attendees — so the checkout's own consumeModifierStock loses the race and
 * rolls the just-created attendee back. The discount zeroes the total, routing
 * the order through the free path. `fields` selects an email or phone listing. */
const setupSoldOutModifierRace = async (
  fields: "email" | "phone" = "email",
) => {
  const listing = await createTestListing({
    fields,
    maxAttendees: 10,
    thankYouUrl: "https://example.com",
    unitPrice: 1000,
  });
  const modifier = await modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 10,
    direction: "discount",
    name: "Comp",
    stock: 1,
  });
  await getDb().execute(
    `CREATE TRIGGER test_consume_modifier_before_order
     AFTER INSERT ON attendees
     BEGIN
       INSERT INTO modifier_usages
         (modifier_id, attendee_id, quantity, amount_applied, created)
       VALUES (${modifier.id}, NEW.id, 1, 1000, '2024-01-01T00:00:00Z');
     END`,
  );
  return { listing, modifier };
};

/** Total recorded contact activity across every contact. Zero means a
 * rolled-back order left no phantom visit or booking behind — for any identity,
 * email or phone — without the test needing to know which hash was used. */
const totalContactActivity = async (): Promise<{
  visits: number;
  bookings: number;
}> => {
  const { rows } = await getDb().execute(
    "SELECT COALESCE(SUM(visits), 0) AS visits, COALESCE(SUM(public_booking_count), 0) AS bookings FROM contact_preferences",
  );
  return {
    bookings: Number(rows[0]!.bookings),
    visits: Number(rows[0]!.visits),
  };
};

const modifierUsageAmount = async (modifierId: number): Promise<number> => {
  const { rows } = await getDb().execute({
    args: [modifierId],
    sql: "SELECT COALESCE(SUM(amount_applied), 0) AS c FROM modifier_usages WHERE modifier_id = ?",
  });
  return Number(rows[0]!.c);
};

const modifierRefs = (id: number, quantity = 1): string =>
  JSON.stringify([{ i: id, q: quantity }]);

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

    test("distributes reservation deposits across multiple listings", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const general = await createTestListing({
        maxAttendees: 10,
        name: "General admission",
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const vip = await createTestListing({
        maxAttendees: 10,
        name: "VIP admission",
        thankYouUrl: "https://example.com",
        unitPrice: 2000,
      });
      const session = stubPaidSession(
        "cs_multi_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([
            { e: general.id, p: 1000, q: 1 },
            { e: vip.id, p: 2000, q: 1 },
          ]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        300,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dep"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.remainingBalance).toBe(2700);
        const paidRows = await getDb().execute({
          args: [attendee.id],
          sql: "SELECT listing_id, price_paid FROM listing_attendees WHERE attendee_id = ?",
        });
        const paidByListing = new Map(
          paidRows.rows.map((row) => [
            Number(row.listing_id),
            Number(row.price_paid),
          ]),
        );
        expect(paidByListing.get(general.id)).toBe(100);
        expect(paidByListing.get(vip.id)).toBe(200);
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

    test("a reservation public-default still resolves modifiers before checkout", async () => {
      await setupStripe();
      await setPublicReservation("10%");
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
        expect(captured?.reservationAmount).toBe("10%");
        expect(captured?.modifiers).toHaveLength(1);
        expect(captured?.modifiers?.[0]?.value).toBe(10);
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

    test("records clamped stock usage for zero-total modifier bookings", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 20,
        direction: "discount",
        name: "Comp",
        stock: 1,
      });

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com");
      expect(await modifierUsedQuantities([modifier.id])).toEqual(
        new Map([[modifier.id, 1]]),
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(1000);
    });

    test("rolls back a zero-total modifier booking when stock sells out after pricing", async () => {
      await setupStripe();
      const { listing, modifier } = await setupSoldOutModifierRace();

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location") ?? "").toMatch(
        new RegExp(`^/ticket/${listing.slug}\\?flash=`),
      );
      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      expect(await modifierUsedQuantities([modifier.id])).toEqual(new Map());
      expect(await attendeeCount()).toBe(0);
      // The greedy create recorded a visit + public booking for this contact;
      // the stock rollback must undo both so a sold-out free order leaves no
      // phantom contact history (matching the paid SumUp-webhook path).
      expect(await totalContactActivity()).toEqual({ bookings: 0, visits: 0 });
    });

    test("reverses a phone contact's counters when a free order's stock rolls back", async () => {
      await setupStripe();
      // A phone-only listing identifies the buyer by phone hash, exercising the
      // SMS-reachable contact path rather than email.
      const { listing } = await setupSoldOutModifierRace("phone");

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        name: "Buyer",
        phone: "07700900123",
      });

      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      expect(await attendeeCount()).toBe(0);
      // The phone identity must be compensated just like email: a sold-out free
      // order leaves no visit or booking on the texted contact.
      expect(await totalContactActivity()).toEqual({ bookings: 0, visits: 0 });
    });

    test("keeps a returning contact's earlier booking when a later free order rolls back", async () => {
      await setupStripe();
      // This contact already has one genuine public booking + visit on record.
      const emailHash = await hashEmail("buyer@example.com");
      await recordVisit(emailHash);
      await recordBooking(emailHash, "public");

      const { listing } = await setupSoldOutModifierRace();
      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      expect(await attendeeCount()).toBe(0);
      // The rollback decrements by exactly one (clamped at zero), so the earlier
      // booking survives — a rejected order must never wipe real history.
      expect(await totalContactActivity()).toEqual({ bookings: 1, visits: 1 });
    });

    test("full-payment promo discount stores the discounted price paid", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const promo = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "SAVE10",
        trigger: "code",
      });
      const session = stubPaidSession(
        "cs_full_discount",
        {
          _origin: "localhost",
          email: "buyer@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(promo.id),
          name: "Buyer",
        },
        900,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_full_discount"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.pricePaid).toBe(900);
        expect(attendee.remainingBalance).toBe(0);
        expect(await modifierUsageCount(promo.id)).toBe(1);
        expect(await modifierUsageAmount(promo.id)).toBe(100);
      } finally {
        session.restore();
      }
    });

    test("carries resolved modifiers into a reservation checkout", async () => {
      await setupStripe();
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
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
        expect(captured?.reservationAmount).toBe("10%");
        expect(captured?.modifiers).toHaveLength(1);
      } finally {
        checkout.restore();
      }
    });

    test("free listing with a selected add-on uses paid reservation checkout", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
      });
      await getDb().execute({
        args: ["optional", addOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });
      let captured: CheckoutIntent | undefined;
      const checkout = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.example/checkout",
            sessionId: "cs_free_addon",
          });
        },
      );
      try {
        const response = await submitTicketForm(listing.slug, {
          [`addon_${addOn.id}`]: "1",
          [`quantity_${listing.id}`]: "1",
          email: "buyer@example.com",
          name: "Buyer",
        });
        expect([302, 303]).toContain(response.status);
        expect(captured?.items[0]?.unitPrice).toBe(0);
        expect(captured?.reservationAmount).toBe("10%");
        expect(captured?.modifiers?.[0]?.id).toBe(addOn.id);
        expect(captured?.modifiers?.[0]?.quantity).toBe(1);
      } finally {
        checkout.restore();
      }
    });

    test("reservation with a positive add-on stores the modified balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
      });
      // Full modified subtotal £20.00, deposit 10% = £2.00.
      const session = stubPaidSession(
        "cs_addon_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(addOn.id, 2),
          name: "Reserver",
          reservation_amount: "10%",
        },
        200,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_addon_dep"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.pricePaid).toBe(200);
        expect(attendee.remainingBalance).toBe(1800);
        expect(await modifierUsageCount(addOn.id)).toBe(2);
        expect(await modifierUsageAmount(addOn.id)).toBe(1000);
      } finally {
        session.restore();
      }
    });

    test("refunds a zero-price reservation add-on when the total mismatches", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
      });
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_free_addon" } as never),
      );
      const session = stubPaidSession(
        "cs_free_addon_bad",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 0, q: 1 }]),
          modifiers: modifierRefs(addOn.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        40,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_free_addon_bad"),
        );
        expect(response.status).toBe(409);
        expect(await attendeeCount()).toBe(0);
        expect(await modifierUsageCount(addOn.id)).toBe(0);
        expect(refund.calls[0]!.args).toEqual(["pi_cs_free_addon_bad"]);
      } finally {
        session.restore();
        refund.restore();
      }
    });

    test("reservation balance page projects the gross sale (deposit accuracy deferred to concern 5)", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const promo = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "SAVE10",
        trigger: "code",
      });
      // Full modified subtotal £9.00, deposit 10% = £0.90.
      const session = stubPaidSession(
        "cs_discount_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(promo.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        90,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_discount_dep"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.remainingBalance).toBe(810);
        expect(await modifierUsageCount(promo.id)).toBe(1);
        expect(await modifierUsageAmount(promo.id)).toBe(100);

        // Concern 4 projects price_paid from the per-row ledger SALE leg, which
        // is the gross list price (1000), not the 90 reservation deposit. So the
        // order summary's "already paid" (depositPaid) and "full order price"
        // overstate to the gross sale; only the balance due (remaining_balance,
        // £8.10) stays accurate. No live site takes reservations, so this is
        // accepted — concern 5 restores the deposit/owed model for the page.
        const summary = await getAttendeeOrderSummary(attendee.id);
        expect(summary.depositPaid).toBe(1000); // gross sale leg, not the 90 deposit
        expect(summary.fullPrice).toBe(1810); // gross sale + remaining balance

        const token = await signBalanceToken(attendee.id);
        const html = await (
          await handleRequest(mockRequest(`/pay/${token}`))
        ).text();
        expect(html).toContain("Full order price");
        expect(html).toContain("£8.10"); // balance due — still correct
      } finally {
        session.restore();
      }
    });

    test("sold-out reservation add-on rolls back attendee creation", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
        stock: 0,
      });
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_addon" } as never),
      );
      const session = stubPaidSession(
        "cs_addon_sold",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(addOn.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        150,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_addon_sold"),
        );
        expect(response.status).toBe(409);
        expect(await attendeeCount()).toBe(0);
        expect(await modifierUsageCount(addOn.id)).toBe(0);
        expect(refund.calls[0]!.args).toEqual(["pi_cs_addon_sold"]);
      } finally {
        session.restore();
        refund.restore();
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

    test("zero-deposit reservations without a fee skip the provider but keep the full balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      const statusId = await setPublicReservation("0");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com");
      const attendee = await latestAttendee();
      expect(attendee.pricePaid).toBe(0);
      expect(attendee.remainingBalance).toBe(1000);
      expect(attendee.statusId).toBe(statusId);
    });

    test("reservation discounts reduce the paid deposit and remaining balance", async () => {
      await setupStripe();
      await settings.update.bookingFee("0");
      const statusId = await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "discount",
        name: "Discount",
      });
      const session = stubPaidSession(
        "cs_discounted_reservation",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        50,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_discounted_reservation"),
        );
        expect([200, 302, 303]).toContain(response.status);
        const attendee = await latestAttendee();
        expect(attendee.pricePaid).toBe(50);
        expect(attendee.remainingBalance).toBe(450);
        expect(attendee.statusId).toBe(statusId);
      } finally {
        session.restore();
      }
    });
  },
);

describeWithEnv(
  "server (booking without a payment provider)",
  { db: true },
  () => {
    afterEach(() => resetStripeClient());

    test("books a paid listing owing its full value when no provider is set up", async () => {
      // No setupStripe: payments are disabled. A booking fee is configured to
      // prove it is never folded into the amount owed when no payment is taken.
      await settings.update.bookingFee("10");
      // The seeded public-default status is the plain non-reservation
      // "Confirmed", so the full balance is owed regardless of any configured
      // reservation amount — exactly as a zero-deposit reservation behaves.
      const status = await getPublicDefaultStatus();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "2",
        email: "buyer@example.com",
        name: "Buyer",
      });

      // The order comes through just like a normal free reservation.
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com");
      const attendee = await latestAttendee();
      // Nothing collected up front; the full £20.00 (2 × £10.00) is owed, with
      // no booking fee added (no payment was processed).
      expect(attendee.pricePaid).toBe(0);
      expect(attendee.remainingBalance).toBe(2000);
      expect(attendee.statusId).toBe(status!.id);
    });

    test("a free listing still owes nothing without a provider", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expect(response.status).toBe(302);
      const attendee = await latestAttendee();
      expect(attendee.pricePaid).toBe(0);
      expect(attendee.remainingBalance).toBe(0);
    });

    test("folds add-on impact into the owed balance without a provider", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Programme",
      });
      await getDb().execute({
        args: ["optional", addOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });

      const response = await submitTicketForm(listing.slug, {
        [`addon_${addOn.id}`]: "1",
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "Buyer",
      });

      expect(response.status).toBe(302);
      const attendee = await latestAttendee();
      // £10.00 ticket + £5.00 add-on = £15.00 owed, nothing collected up front.
      expect(attendee.pricePaid).toBe(0);
      expect(attendee.remainingBalance).toBe(1500);
      // The add-on impact and stock are recorded just as a zero-deposit
      // reservation's would be, even though no money changed hands.
      expect(await modifierUsageCount(addOn.id)).toBe(1);
      expect(await modifierUsageAmount(addOn.id)).toBe(500);
    });
  },
);
