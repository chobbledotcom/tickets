/** Real customer and owner journeys used by the refund safety stories. */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import { requireListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  adminBrowser,
  CUSTOMER,
  expectAccepted,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { sellPlacesAt } from "#test/specs/support/money.ts";
import {
  expectNotBooked,
  type FilledOrder,
  soleBookingOn,
  visitorFillsInBooking,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { completePaidCheckout } from "#test-utils/order-journey.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { makeSumupClient, withSumupClient } from "#test-utils/sumup.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { PaymentProviderType } from "#types";
import { refundSafety, type SafetyBooking, safetyBooking } from "./state.ts";

// jscpd:ignore-end

const safeName = (value: string): string =>
  value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");

type OwnerJourney = (world: TicketsWorld, who: string) => Promise<TestBrowser>;

const HOSTED_CHECKOUT_URL = "https://provider.test/checkout";

export const openAttendeeAsOwner: OwnerJourney = async (world, who) => {
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

export type RefundStoryProvider = Extract<
  PaymentProviderType,
  "stripe" | "sumup"
>;
interface PaidBooking
  extends Pick<SafetyBooking, "amount" | "paymentReference" | "sessionId"> {
  readonly browser: TestBrowser;
}

type PaymentArgs = [filled: FilledOrder, name: string];
type CompletePublicPayment = (...args: PaymentArgs) => Promise<PaidBooking>;

/** Press the visitor's real Continue button and require a hosted checkout. */
const startHostedCheckout = async (
  filled: FilledOrder,
): Promise<TestBrowser> => {
  const browser = expectNotBooked(await filled.press());
  expect(browser.redirectedTo).toBe(HOSTED_CHECKOUT_URL);
  return browser;
};

const completeStripePayment: CompletePublicPayment = async (filled, name) => {
  const sessionId = `cs_safety_${name}`;
  let intent: CheckoutIntent | null = null;
  const checkout = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    (created) => {
      intent = created;
      return Promise.resolve({
        checkoutUrl: HOSTED_CHECKOUT_URL,
        sessionId,
      });
    },
  );
  let browser: TestBrowser;
  try {
    browser = await startHostedCheckout(filled);
  } finally {
    checkout.restore();
  }
  if (intent === null) {
    throw new Error("The public booking never reached Stripe");
  }
  await completePaidCheckout(intent, sessionId);
  return {
    amount: priceCheckout(intent).total,
    browser,
    paymentReference: `pi_${sessionId}`,
    sessionId,
  };
};

const sumupCheckoutRequest = v.object({
  amount: v.number(),
  checkout_reference: v.string(),
});

const setupSumupPayment = async (): Promise<void> => {
  await settings.update.sumup.apiKey("sumup_refund_story");
  await settings.update.sumup.merchantCode("SUMUP_STORY");
  await settings.update.paymentProvider("sumup");
};

const completeSumupPayment: CompletePublicPayment = async (filled, name) => {
  const checkoutId = `co_safety_${name}`;
  let amount: number | null = null;
  let reference: string | null = null;
  let browser: TestBrowser | null = null;
  await withSumupClient(
    makeSumupClient({
      create: (body) => {
        const request = v.parse(sumupCheckoutRequest, body);
        amount = Math.round(request.amount * 100);
        reference = request.checkout_reference;
        return Promise.resolve({
          hosted_checkout_url: HOSTED_CHECKOUT_URL,
          id: checkoutId,
        });
      },
    }),
    async () => {
      browser = await startHostedCheckout(filled);
    },
  );
  const missingCheckout = "The public booking never reached SumUp";
  const paidAmount = requireValue<number>(amount, missingCheckout);
  const checkoutReference = requireValue<string>(reference, missingCheckout);
  const completedBrowser = requireValue<TestBrowser>(browser, missingCheckout);
  const transactionId = `txn_safety_${name}`;
  const readCheckout = stub(sumupApi, "readCheckoutById", (id) => {
    expect(id).toBe(checkoutId);
    return Promise.resolve({
      resource: {
        amountMinor: paidAmount,
        currency: "GBP",
        reference: checkoutReference,
        status: "PAID" as const,
        transactionId,
      },
      status: "found" as const,
    });
  });
  try {
    const response = await handleRequest(
      mockWebhookRequest({
        event_type: "CHECKOUT_STATUS_CHANGED",
        id: checkoutId,
      }),
    );
    expect(await expectAccepted(response).json()).toMatchObject({
      processed: true,
    });
  } finally {
    readCheckout.restore();
  }
  return {
    amount: paidAmount,
    browser: completedBrowser,
    paymentReference: transactionId,
    sessionId: checkoutReference,
  };
};

type PublicPaymentDriver = {
  complete: CompletePublicPayment;
  setup(): Promise<void>;
};

const PUBLIC_PAYMENT_DRIVERS = {
  stripe: { complete: completeStripePayment, setup: setupStripe },
  sumup: { complete: completeSumupPayment, setup: setupSumupPayment },
} satisfies Record<RefundStoryProvider, PublicPaymentDriver>;

/** Buy one paid place from the public page, then let its real callback finish. */
export const buyPaidPlaceThroughPublicPage = async (
  world: TicketsWorld,
  who: string,
  pounds: string,
  listingName: string,
  provider: RefundStoryProvider,
): Promise<SafetyBooking> => {
  const driver = PUBLIC_PAYMENT_DRIVERS[provider];
  await driver.setup();
  const listing = await sellPlacesAt(world, listingName, pounds);
  const filled = await visitorFillsInBooking(listing, {
    email: `${safeName(who)}@example.com`,
    who,
  });
  const name = safeName(`${who}_${listingName}`);
  const completed = await driver.complete(filled, name);
  const attendeeId = await soleBookingOn(listing.id);
  const booking: SafetyBooking = {
    amount: completed.amount,
    attendeeId,
    listingId: listing.id,
    paymentReference: completed.paymentReference,
    sessionId: completed.sessionId,
    who,
  };
  refundSafety(world).bookings.set(who, booking);
  world.attendeeId = attendeeId;
  world.attendeeName = who;
  rememberBrowser(world, CUSTOMER, completed.browser);
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

const isListedRefundCase = (link: { readonly text: string }): boolean =>
  link.text.trim().startsWith("Open refund ");

/** Follow the first concrete refund case from a rendered recovery queue. */
export const openListedRefundCase = async (
  browser: TestBrowser,
): Promise<void> => {
  const detail = browser.links.find(isListedRefundCase);
  if (detail === undefined) {
    throw new Error("Refund recovery listed no provider case");
  }
  await browser.clickLink(detail.text);
};

interface OwnerActionForm {
  readonly action: string;
  readonly button: string;
}

function submitOwnerAction(form: OwnerActionForm): OwnerJourney {
  return async (world, who) => {
    const browser = await openOwnerAction(world, who, form.action);
    await fillInAndSend(browser, { confirm_identifier: who }, form.button);
    return browser;
  };
}

/** Submit the rendered owner refund form and keep the page it leads to. */
export const ownerRefunds: OwnerJourney = submitOwnerAction({
  action: "Refund",
  button: "Refund Attendee",
});

/** Submit the real attendee deletion form after payment work has finished. */
export const ownerDeletesAttendee: OwnerJourney = submitOwnerAction({
  action: "Delete",
  button: "Delete Attendee",
});

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
