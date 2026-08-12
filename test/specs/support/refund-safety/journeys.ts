/** Real customer and owner journeys used by the refund safety stories. */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  adminBrowser,
  CUSTOMER,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { sellPlacesAt, soleBookingOn } from "#test/specs/support/money.ts";
import {
  visitorFillsInBooking,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { completePaidCheckout } from "#test-utils/order-journey.ts";
import { setupStripe } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import { refundSafety, type SafetyBooking, safetyBooking } from "./state.ts";

// jscpd:ignore-end

const safeName = (value: string): string =>
  value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");

type OwnerJourney = (world: TicketsWorld, who: string) => Promise<TestBrowser>;

const openAttendeeAsOwner: OwnerJourney = async (world, who) => {
  const browser = await adminBrowser(world);
  await browser.clickLink("Attendees");
  await browser.clickLink(who);
  return browser;
};

const continueFromAttendee =
  (continueJourney: (browser: TestBrowser) => Promise<void>): OwnerJourney =>
  async (world, who) => {
    const browser = await openAttendeeAsOwner(world, who);
    await continueJourney(browser);
    return browser;
  };

/** Buy one paid place from the public page, then let the real webhook finish it. */
export const buyPaidPlaceThroughPublicPage = async (
  world: TicketsWorld,
  who: string,
  pounds: string,
  listingName: string,
): Promise<SafetyBooking> => {
  await setupStripe();
  const listing = await sellPlacesAt(world, listingName, pounds);
  const filled = await visitorFillsInBooking(listing, {
    email: `${safeName(who)}@example.com`,
    who,
  });
  const name = safeName(`${who}_${listingName}`);
  const sessionId = `cs_safety_${name}`;
  let intent: CheckoutIntent | null = null;
  const checkout = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    (created) => {
      intent = created;
      return Promise.resolve({
        checkoutUrl: "https://provider.test/checkout",
        sessionId,
      });
    },
  );
  let browser: TestBrowser;
  try {
    const attempt = await filled.press();
    browser = attempt.browser;
    expect(attempt.wasBooked).toBe(false);
    expect(browser.redirectedTo).toBe("https://provider.test/checkout");
  } finally {
    checkout.restore();
  }
  if (intent === null) {
    throw new Error("The public booking never reached the payment provider");
  }
  await completePaidCheckout(intent, sessionId);
  const attendeeId = await soleBookingOn(listing.id);
  const booking: SafetyBooking = {
    amount: Math.round(Number(pounds) * 100),
    attendeeId,
    listingId: listing.id,
    paymentReference: `pi_${sessionId}`,
    sessionId,
    who,
  };
  refundSafety(world).bookings.set(who, booking);
  world.attendeeId = attendeeId;
  world.attendeeName = who;
  rememberBrowser(world, CUSTOMER, browser);
  return booking;
};

/** Buy one free place through its public page, keeping it separate by listing. */
export const buyFreePlaceThroughPublicPage = async (
  world: TicketsWorld,
  who: string,
  listingName: string,
): Promise<number> => {
  const listing = await sellPlacesAt(world, listingName, "0.00");
  const attempt = await visitorTriesToBook(listing, {
    email: `${safeName(who)}.${safeName(listingName)}@example.com`,
    who,
  });
  expect(attempt.wasBooked).toBe(true);
  return await soleBookingOn(listing.id);
};

/** Walk from the attendee page to its Actions tab as the owner. */
export const openActionsAsOwner: OwnerJourney = continueFromAttendee(
  (browser) => browser.clickLink("Actions"),
);

/** Follow one attendee action link from the real Actions page. */
export const openOwnerAction = async (
  world: TicketsWorld,
  who: string,
  action: string,
): Promise<TestBrowser> => {
  const browser = await openActionsAsOwner(world, who);
  await browser.clickLink(action);
  return browser;
};

/** Submit the rendered owner refund form and keep the page it leads to. */
export const ownerRefunds: OwnerJourney = async (world, who) => {
  const browser = await openOwnerAction(world, who, "Refund");
  await fillInAndSend(browser, { confirm_identifier: who }, "Refund Attendee");
  return browser;
};

/** Press the attendee overview's rendered provider refresh button. */
export const ownerRefreshesPayment: OwnerJourney = continueFromAttendee(
  (browser) => browser.submitForm({}, "Refresh payment status"),
);

/** Reload the stored listing after a journey that may have changed it. */
export const safetyListing = (
  world: TicketsWorld,
  who: string,
): ReturnType<typeof requireListingWithCount> =>
  requireListingWithCount(safetyBooking(world, who).listingId);
