// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

/**
 * Stub `retrieveCheckoutSession` with the given session, follow the
 * `/payment/success` redirect to completion, and return the listing's
 * attendees — the stub/redirect/getAttendeesRaw scaffold every pricePaid test
 * in this file shares, varying only the session payload and the resulting
 * price/quantity it asserts on.
 */
const followPaymentRedirectAndGetAttendees = async (
  session: {
    amountTotal: number;
    sessionId: string;
    items: string;
    email: string;
    name: string;
    paymentIntent: string;
  },
  listingId: number,
) => {
  const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: session.amountTotal,
      id: session.sessionId,
      metadata: signMeta(
        webhookMeta({
          email: session.email,
          items: session.items,
          name: session.name,
        }),
        session.amountTotal,
      ),
      payment_intent: session.paymentIntent,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

  try {
    const redirectResponse = await handleRequest(
      mockRequest(`/payment/success?session_id=${session.sessionId}`),
    );
    expect(redirectResponse.status).toBe(302);
    const response = await followRedirect(redirectResponse, handleRequest);
    expect(response.status).toBe(200);

    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    return await getAttendeesRaw(listingId);
  } finally {
    mockRetrieve.restore();
  }
};

/** Assert the sole attendee's recorded quantity/price_paid — the tail check
 *  every pricePaid test in this file ends with. */
const expectPricePaid = (
  attendees: Awaited<ReturnType<typeof followPaymentRedirectAndGetAttendees>>,
  quantity: number,
  pricePaid: number,
): void => {
  expect(attendees.length).toBe(1);
  expect(attendees[0]?.quantity).toBe(quantity);
  expect((attendees[0] as unknown as Record<string, unknown>).price_paid).toBe(
    pricePaid,
  );
};

describeWithEnv("server webhooks > pricePaid calculation", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("multi-ticket pricePaid calculation uses unit_price * quantity", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Multi Price Calc",
      unitPrice: 500,
    });

    const attendees = await followPaymentRedirectAndGetAttendees(
      {
        amountTotal: 1500,
        email: "price@example.com",
        items: JSON.stringify([{ e: listing.id, p: 1500, q: 3 }]),
        name: "Price Test",
        paymentIntent: "pi_multi_price",
        sessionId: "cs_multi_price",
      },
      listing.id,
    );
    expectPricePaid(attendees, 3, 1500);
  });

  test("single-ticket pricePaid calculation uses unit_price * quantity", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      maxQuantity: 5,
      unitPrice: 1000,
    });

    const attendees = await followPaymentRedirectAndGetAttendees(
      {
        amountTotal: 2000,
        email: "price@example.com",
        items: singleItem(listing.id, 2, 2000),
        name: "Price Single",
        paymentIntent: "pi_single_price",
        sessionId: "cs_single_price",
      },
      listing.id,
    );
    expectPricePaid(attendees, 2, 2000);
  });

  test("multi-ticket pricePaid records zero when listing has no unit_price", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "WH Multi Free",
    });

    const attendees = await followPaymentRedirectAndGetAttendees(
      {
        amountTotal: 0,
        email: "freemulti@example.com",
        items: JSON.stringify([{ e: listing.id, p: 0, q: 2 }]),
        name: "Free Multi",
        paymentIntent: "pi_multi_free",
        sessionId: "cs_multi_free",
      },
      listing.id,
    );
    expectPricePaid(attendees, 2, 0);
  });

  test("single-ticket pricePaid records zero when listing has no unit_price", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "WH Single Free",
    });

    const attendees = await followPaymentRedirectAndGetAttendees(
      {
        amountTotal: 0,
        email: "freesingle@example.com",
        items: singleItem(listing.id, 2, 0),
        name: "Free Single",
        paymentIntent: "pi_single_free",
        sessionId: "cs_single_free",
      },
      listing.id,
    );
    expectPricePaid(attendees, 2, 0);
  });
});
