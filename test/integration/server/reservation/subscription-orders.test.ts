import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import { processBooking } from "#shared/booking.ts";
import { expectFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMonthlyPlan } from "#test-utils/db-helpers/subscriptions.ts";
import { expectNoBooking, makeParent } from "#test-utils/parents.ts";
import {
  setPublicReservation,
  submitBuyerOrder,
} from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  stripeCheckoutSession,
  stripeClient,
} from "#test-utils/stripe/fixtures.ts";

const CONTACT = {
  address: "",
  email: "member@example.com",
  name: "Member",
  phone: "",
  special_instructions: "",
};

const NEEDS_STRIPE = "payment.error.subscription_needs_stripe";
const FREE = "payment.error.subscription_free";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test";

type SessionRequest = Parameters<
  Awaited<ReturnType<typeof stripeClient>>["checkout"]["sessions"]["create"]
>[0];

/** Run `body` while Stripe answers every checkout, and report the one
 * checkout that the site asked for. */
const withStubbedCheckout = async (
  body: () => Promise<void>,
): Promise<SessionRequest> => {
  const client = await stripeClient();
  using create = stub(client.checkout.sessions, "create", () =>
    Promise.resolve(stripeCheckoutSession()),
  );
  await body();
  expect(create.calls.length).toBe(1);
  return create.calls[0]!.args[0];
};

/** The mode of a checkout and the amount, frequency, and quantity of each
 * of its lines. */
const subscriptionLines = (asked: SessionRequest) => ({
  lines: asked.line_items?.map(({ price_data, quantity }) => ({
    amount: price_data?.unit_amount,
    interval: price_data?.recurring?.interval,
    quantity,
  })),
  mode: asked.mode,
});

/** Book one monthly parent ticket priced `unitPrice`, with one free child,
 * through the API. */
const bookParentThroughApi = async (unitPrice: number) => {
  const { child, parent } = await makeParent({
    children: [{ maxAttendees: 10, unitPrice: 0 }],
    parent: { maxAttendees: 10, unitPrice },
  });
  const response = await processParentApiBooking(
    new Request("http://localhost/api/listings/x/book", {
      headers: { host: "localhost" },
      method: "POST",
    }),
    await withMonthlyPlan(parent),
    {
      children: [{ quantity: 1, slug: child.slug }],
      email: CONTACT.email,
      name: CONTACT.name,
      quantity: 1,
    },
    1,
    null,
  );
  return { parent, response };
};

const monthlyListing = async () =>
  withMonthlyPlan(
    await createTestListing({ maxAttendees: 10, unitPrice: 1000 }),
  );

/** Submit one ticket of `listing` on the public page and expect the refusal
 * `message`, with no booking made. */
const expectRefusedOrder = async (
  listing: { id: number; slug: string },
  message: string,
): Promise<void> => {
  const response = await submitBuyerOrder(listing);
  expect(response.status).toBe(302);
  expectFlash(response, t(message), false);
  await expectNoBooking(listing);
};

describeWithEnv("subscription orders", { db: true, triggers: true }, () => {
  test("refuses a subscription that a free reservation would book", async () => {
    await setupStripe();
    await settings.update.bookingFee("0");
    await setPublicReservation("0");
    await expectRefusedOrder(
      await monthlyListing(),
      "payment.error.subscription_free",
    );
  });

  test("refuses a subscription on a site that takes no payment", async () => {
    await expectRefusedOrder(await monthlyListing(), NEEDS_STRIPE);
  });

  test("refuses a subscription through the API on a site that takes no payment", async () => {
    const listing = await monthlyListing();
    expect(
      await processBooking(listing, CONTACT, 1, null, "http://localhost"),
    ).toEqual({ error: t(NEEDS_STRIPE), type: "checkout_failed" });
    await expectNoBooking(listing);
  });

  test("refuses a subscription parent through the API on a site that takes no payment", async () => {
    const { parent, response } = await bookParentThroughApi(1000);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: t(NEEDS_STRIPE) });
    await expectNoBooking(parent);
  });

  test("refuses a subscription through the API when nothing is paid today", async () => {
    await setupStripe();
    const listing = await monthlyListing();
    expect(
      await processBooking(listing, CONTACT, 1, null, "http://localhost", 0),
    ).toEqual({ error: t(FREE), type: "checkout_failed" });
    await expectNoBooking(listing);
  });

  test("refuses a subscription parent through the API when nothing is paid today", async () => {
    await setupStripe();
    const { parent, response } = await bookParentThroughApi(0);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: t(FREE) });
    await expectNoBooking(parent);
  });

  test("starts a Stripe subscription checkout through the API", async () => {
    await setupStripe();
    const listing = await monthlyListing();
    const asked = await withStubbedCheckout(async () => {
      expect(
        await processBooking(listing, CONTACT, 2, null, "http://localhost"),
      ).toEqual({ checkoutUrl: CHECKOUT_URL, type: "checkout" });
    });
    expect(subscriptionLines(asked)).toEqual({
      lines: [
        { amount: 1000, interval: undefined, quantity: 2 },
        { amount: 1000, interval: "month", quantity: 1 },
      ],
      mode: "subscription",
    });
  });

  test("starts a Stripe subscription checkout for a parent through the API", async () => {
    await setupStripe();
    const asked = await withStubbedCheckout(async () => {
      const { response } = await bookParentThroughApi(1000);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        booking: { checkoutUrl: CHECKOUT_URL },
      });
    });
    expect(subscriptionLines(asked).mode).toBe("subscription");
  });
});
