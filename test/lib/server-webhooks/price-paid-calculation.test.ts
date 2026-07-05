import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  createTestListing,
  describeWithEnv,
  followRedirect,
  mockRequest,
  setupStripe,
  signMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

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

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1500,
        id: "cs_multi_price",
        metadata: signMeta(
          webhookMeta({
            email: "price@example.com",
            items: JSON.stringify([{ e: listing.id, p: 1500, q: 3 }]),
            name: "Price Test",
          }),
          1500,
        ),
        payment_intent: "pi_multi_price",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const redirectResponse = await handleRequest(
        mockRequest("/payment/success?session_id=cs_multi_price"),
      );
      expect(redirectResponse.status).toBe(302);
      const response = await followRedirect(redirectResponse, handleRequest);
      expect(response.status).toBe(200);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(3);
      expect(
        (attendees[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(1500);
    } finally {
      mockRetrieve.restore();
    }
  });

  test("single-ticket pricePaid calculation uses unit_price * quantity", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      maxQuantity: 5,
      unitPrice: 1000,
    });

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 2000,
        id: "cs_single_price",
        metadata: signMeta(
          webhookMeta({
            email: "price@example.com",
            items: singleItem(listing.id, 2, 2000),
            name: "Price Single",
          }),
          2000,
        ),
        payment_intent: "pi_single_price",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const redirectResponse = await handleRequest(
        mockRequest("/payment/success?session_id=cs_single_price"),
      );
      expect(redirectResponse.status).toBe(302);
      const response = await followRedirect(redirectResponse, handleRequest);
      expect(response.status).toBe(200);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(
        (attendees[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(2000);
    } finally {
      mockRetrieve.restore();
    }
  });

  test("multi-ticket pricePaid records zero when listing has no unit_price", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "WH Multi Free",
    });

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 0,
        id: "cs_multi_free",
        metadata: signMeta(
          webhookMeta({
            email: "freemulti@example.com",
            items: JSON.stringify([{ e: listing.id, p: 0, q: 2 }]),
            name: "Free Multi",
          }),
          0,
        ),
        payment_intent: "pi_multi_free",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const redirectResponse = await handleRequest(
        mockRequest("/payment/success?session_id=cs_multi_free"),
      );
      expect(redirectResponse.status).toBe(302);
      const response = await followRedirect(redirectResponse, handleRequest);
      expect(response.status).toBe(200);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(2);
      expect(
        (attendees[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(0);
    } finally {
      mockRetrieve.restore();
    }
  });

  test("single-ticket pricePaid records zero when listing has no unit_price", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      name: "WH Single Free",
    });

    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 0,
        id: "cs_single_free",
        metadata: signMeta(
          webhookMeta({
            email: "freesingle@example.com",
            items: singleItem(listing.id, 2, 0),
            name: "Free Single",
          }),
          0,
        ),
        payment_intent: "pi_single_free",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const redirectResponse = await handleRequest(
        mockRequest("/payment/success?session_id=cs_single_free"),
      );
      expect(redirectResponse.status).toBe(302);
      const response = await followRedirect(redirectResponse, handleRequest);
      expect(response.status).toBe(200);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(2);
      expect(
        (attendees[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(0);
    } finally {
      mockRetrieve.restore();
    }
  });
});
