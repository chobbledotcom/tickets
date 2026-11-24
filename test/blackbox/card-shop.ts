/**
 * A shop that takes card payments through the fake Stripe, for black-box
 * tests of the paid booking journey: the owner sets the key, a buyer books
 * through the booking form, and the test sends Stripe's signed callbacks.
 */

import { expect } from "@std/expect";
import { afterEach } from "@std/testing/bdd";
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
  addBooking,
  addListing,
  openApi,
  type SeededListing,
} from "#test/blackbox/seed.ts";

/** Where the shop's listing sends a buyer after the booking. */
export const THANK_YOU_URL = "https://example.com/thanks";

export interface CardShop {
  readonly api: Api;
  readonly fake: FakeStripe;
  readonly listing: SeededListing;
  readonly owner: App;
}

/** Open a shop with one 1000 listing that takes Stripe payments. A buyer who
 * books it is sent on to `THANK_YOU_URL`. Close the fake with
 * `shop.fake.close()` when the test ends. */
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
    thank_you_url: THANK_YOU_URL,
    unit_price: 1000,
  });
  return { api, fake, listing, owner };
};

/** A fresh shop for each test of a suite. Call it in the suite's body. It
 * closes the fake Stripe of each test when the test ends. `checkedOut` also
 * books two places and gives back the checkout. */
export const useCardShop = () => {
  let shop: CardShop | undefined;
  afterEach(async () => {
    await shop?.fake.close();
    shop = undefined;
  });
  const open = async (): Promise<CardShop> => {
    shop = await openCardShop();
    return shop;
  };
  const checkedOut = async () => {
    const opened = await open();
    return { checkout: await checkOut(opened), opened };
  };
  return { checkedOut, open };
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
  return lastCheckout(shop);
};

/** The checkout that the app opened last. */
const lastCheckout = (shop: CardShop): FakeCheckout =>
  requireValue(shop.fake.checkouts.at(-1), "The app opened no checkout");

/** The owner books one place by hand with 400 of its 1000 paid. The buyer
 * pays the rest through the pay link on the booking's ledger tab, and is sent
 * to Stripe. Gives back the checkout that the app opened. */
export const checkOutBalance = async (
  shop: CardShop,
): Promise<FakeCheckout> => {
  const id = await addBooking(shop.api, shop.listing, {
    name: "Balance Buyer",
    payments: [{ amount: 400 }],
  });
  const ledger = await shop.owner.get(`/admin/attendees/${id}/ledger`);
  const link = requireValue(
    ledger.html.match(/\/pay\/[^"<\s]+/)?.[0],
    "The ledger tab shows no pay link",
  );
  const sent = await createApp(inProcess).submit(link);
  expect(sent.location).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  return lastCheckout(shop);
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
