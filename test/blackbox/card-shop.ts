/**
 * A shop that takes card payments through the fake Stripe, for black-box
 * tests of the paid booking journey: the owner sets the key, a buyer books
 * through the booking form, and the test sends Stripe's signed callbacks.
 */

import { expect } from "@std/expect";
import * as v from "valibot";
import { requireValue } from "#shared/required-value.ts";
import type { Api } from "#test/blackbox/api.ts";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import {
  type FakeCheckout,
  type FakeStripe,
  startFakeStripe,
} from "#test/blackbox/fake-stripe.ts";
import {
  addListing,
  openApi,
  type SeededListing,
} from "#test/blackbox/seed.ts";

export interface CardShop {
  readonly api: Api;
  readonly fake: FakeStripe;
  readonly listing: SeededListing;
  readonly owner: App;
}

/** Open a shop with one 1000 listing that takes Stripe payments. Close the
 * fake with `shop.fake.close()` when the test ends. */
export const openCardShop = async (): Promise<CardShop> => {
  const fake = await startFakeStripe();
  const owner = createApp(inProcess);
  await owner.logIn();
  await owner.submit(
    "/admin/settings",
    { paymentProvider: "stripe" },
    "/admin/settings/payment-provider",
  );
  const saved = await owner.submit(
    "/admin/settings",
    { stripeSecretKey: "sk_test_blackbox" },
    "/admin/settings/stripe",
  );
  expect(saved.location).toContain("form=settings-stripe");
  const api = await openApi(owner);
  const listing = await addListing(api, {
    max_attendees: 10,
    max_quantity: 4,
    name: "Quiz Night",
    unit_price: 1000,
  });
  return { api, fake, listing, owner };
};

/** A buyer books two places through the booking form and is sent to Stripe.
 * Gives back the checkout that the app opened. */
export const checkOut = async (shop: CardShop): Promise<FakeCheckout> => {
  const buyer = createApp(inProcess);
  const sent = await buyer.submit(`/ticket/${shop.listing.slug}`, {
    email: "buyer@example.com",
    name: "Sealed Buyer",
    [`quantity${shop.listing.id}`]: "2",
  });
  expect(sent.location).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  return requireValue(shop.fake.checkouts.at(-1), "The app opened no checkout");
};

/** Send Stripe's signed "checkout completed" callback for a checkout. */
export const deliverPayment = async (
  shop: CardShop,
  checkout: FakeCheckout,
  changes?: Parameters<FakeStripe["completedEvent"]>[1],
): Promise<Response> => {
  const { body, signature } = await shop.fake.completedEvent(checkout, changes);
  return await inProcess(
    new Request("http://localhost/payment/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        host: "localhost",
        "stripe-signature": signature,
      },
      method: "POST",
    }),
  );
};

const Roster = v.object({
  attendees: v.array(v.looseObject({ name: v.string(), quantity: v.number() })),
});

/** The bookings on the shop's listing, as name and places. */
export const rosterOf = async (
  shop: CardShop,
): Promise<[name: string, quantity: number][]> => {
  const answer = await shop.api.get(
    `/api/admin/listings/${shop.listing.id}/attendees`,
  );
  return v
    .parse(Roster, answer.body)
    .attendees.map(({ name, quantity }) => [name, quantity]);
};

/** The page that a buyer who gives up at Stripe is sent back to. */
export const cancelPage = (checkout: FakeCheckout) =>
  createApp(inProcess).get(`/payment/cancel?session_id=${checkout.id}`);

/** The page that a buyer who comes back from Stripe sees. */
export const returnPage = (checkout: FakeCheckout) =>
  createApp(inProcess).get(`/payment/success?session_id=${checkout.id}`);
