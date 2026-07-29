/**
 * Booking from a code the organiser shows on a screen. The organiser fills in
 * the listing's own "make a booking code" page and it puts a code up; a
 * customer scans it. Both halves go through the real pages, so the story is
 * always using a code the site itself would hand out.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  rememberStayListing,
  stayListing,
} from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite, setupStripe } from "#test-utils/settings.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** What the organiser types on the page that makes the code. A box left out is
 * left as the page had it, the way it would be for a person who fills in one
 * field and presses the button. */
interface CodeWanted {
  places?: number;
  /** In pounds and pence, as the organiser types it on the page. */
  price?: number;
  who?: string;
}

/** Something for sale that the organiser can print a code for. */
export const somethingForSale = async (
  world: TicketsWorld,
  name: string,
  options: { askForEmail?: boolean; canPayMore?: boolean; price: number },
): Promise<void> => {
  await enablePublicSite();
  await setupStripe();
  rememberStayListing(
    world,
    name,
    await createTestListing({
      canPayMore: options.canPayMore ?? false,
      // Nothing beyond a name is asked for unless the story says so, which is
      // what makes a complete code able to skip the form entirely.
      fields: options.askForEmail ? "email" : "",
      maxAttendees: 10,
      name,
      unitPrice: options.price,
    }),
  );
};

/** The screen the organiser is holding up, once they have put a code on it. */
export interface CodeOnScreen {
  /** The address the code points at, which a scan opens. */
  link: string;
  /** What the organiser can read on the screen while they hold it up. */
  page: string;
}

/** The organiser puts a code up for something, through the page that makes
 * them. The code is the whole point, so a page that stops producing one fails
 * the story here. */
export const organiserShowsCode = async (
  world: TicketsWorld,
  name: string,
  wanted: CodeWanted = {},
): Promise<CodeOnScreen> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${stayListing(world, name).id}/qr`);
  await browser.submitForm(
    {
      ...(wanted.who === undefined ? {} : { customer_name: wanted.who }),
      ...(wanted.places === undefined
        ? {}
        : { quantity: String(wanted.places) }),
      ...(wanted.price === undefined ? {} : { value: wanted.price.toFixed(2) }),
    },
    "Generate",
  );
  const link = browser.currentHtml.match(
    /\/ticket\/[^"\s]*\/qr-book\?t=[^"\s]+/,
  );
  if (!link) throw new Error(`The page gave the organiser no code for ${name}`);
  return {
    link: link[0].replaceAll("&amp;", "&"),
    page: browser.currentHtml,
  };
};

/** Where a printed code took the customer. Either it carried everything and
 * they went straight off to pay, or they landed on a page to fill in. */
export interface WhereTheCodeLed {
  /** The page they landed on, when they were not sent to pay. */
  page: string;
  /** What paying would charge, for how many, and in whose name — when they
   * were sent to pay at all. */
  paying: WhatIsBeingCharged | null;
  /** What the site answered with, which callers and caches go by as much as
   * the reader goes by the page. */
  status: number;
}

/** Run `body` with paying stubbed at the provider, so a story can see what the
 * customer would have been charged without a real checkout. */
const withPayingStubbed = async <Answer>(
  body: (paying: {
    timesReached: () => number;
    whatWasCharged: () => PaymentCheckoutCreateSnapshot | undefined;
  }) => Promise<Answer>,
): Promise<Answer> => {
  const { stubCheckout } = await import("#test-utils/checkout.ts");
  const { mockProviderType, withMocks } = await import("#test-utils/mocks.ts");
  const { paymentsApi } = await import("#shared/payments.ts");
  let answer: Answer | undefined;
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const checkout = stubCheckout();
      try {
        answer = await body({
          timesReached: checkout.calls,
          whatWasCharged: checkout.getCaptured,
        });
      } finally {
        checkout.checkout.restore();
      }
    },
  );
  if (answer === undefined) throw new Error("Nothing came of that");
  return answer;
};

/** What the customer is being asked to pay for. */
export interface WhatIsBeingCharged {
  forWhat: string;
  nameOnIt: string;
  places: number;
  priceEach: number;
}

/** Reaching paying with nothing to charge is not a state the site can be in,
 * so it is raised here rather than left to fail somewhere later. Being sent
 * there twice for one press is not either: only the last order would be
 * visible, while the customer would have two of them. */
const whatIsBeingCharged = (
  charged: PaymentCheckoutCreateSnapshot | undefined,
  timesReached: number,
): WhatIsBeingCharged => {
  const line = charged?.order.lines[0];
  if (!line) throw new Error("Paying was reached with nothing to charge for");
  if (timesReached !== 1) {
    throw new Error(`Paying was set up ${timesReached} times, not once`);
  }
  return {
    forWhat: line.name,
    nameOnIt: charged.bookingIntent.name,
    places: line.quantity,
    priceEach: line.amount,
  };
};

/** A customer scans a code that has been up for `secondsOld` seconds. The clock
 * only moves for this one scan, which is what a customer arriving later — or
 * scanning a photo of the screen — actually does. */
export const customerScansLater = async (
  link: string,
  secondsOld: number,
): Promise<WhereTheCodeLed> => {
  const { FakeTime } = await import("@std/testing/time");
  using clock = new FakeTime();
  clock.tick(secondsOld * 1000);
  return await customerScans(link);
};

/** A customer scans a code the moment it goes up. */
export const customerScans = (link: string): Promise<WhereTheCodeLed> =>
  withPayingStubbed(async ({ timesReached, whatWasCharged }) => {
    const { STUB_CHECKOUT_URL } = await import("#test-utils/checkout.ts");
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const response = await handleRequest(mockRequest(link));
    // The whole address has to be the payment page, not merely start like it.
    const sentToPay =
      response.status === 302 &&
      response.headers.get("location") === STUB_CHECKOUT_URL;
    if (sentToPay) response.body?.cancel();
    // A page that quietly set up a payment and then showed a form or an error
    // is not "not sent to pay" — the customer has an order they never made.
    if (!sentToPay && timesReached() !== 0) {
      throw new Error(
        "Paying was set up for a customer who was not sent there",
      );
    }
    return {
      page: sentToPay ? "" : await response.text(),
      paying: sentToPay
        ? whatIsBeingCharged(whatWasCharged(), timesReached())
        : null,
      status: response.status,
    };
  });

/** The box the page offers for choosing what to pay. Its name carries the
 * listing it belongs to, so it is read off the page rather than guessed — a
 * page that stopped offering one fails the story here. */
const priceBoxOn = (html: string): string => {
  const box = html.match(/name="(custom_price[^"]*)"/);
  if (!box?.[1]) throw new Error("The page offers no box for paying more");
  return box[1];
};

/** The customer decides to pay more than the code says. They fill it in on the
 * very page the code opened and press the button on it, so a form whose action,
 * one-use code, or price box was broken fails here. */
export const customerPaysMore = (
  link: string,
  price: number,
): Promise<WhatIsBeingCharged> =>
  withPayingStubbed(async ({ timesReached, whatWasCharged }) => {
    const browser = new TestBrowser();
    await browser.visit(link);
    expect(browser.currentHtml).toContain('name="qr_token"');
    await browser.submitForm(
      {
        [priceBoxOn(browser.currentHtml)]: price.toFixed(2),
        email: "buyer@example.com",
        name: "Ada Lovelace",
      },
      "Continue",
    );
    // Reaching the provider is not the same as the customer getting there: a
    // page that called it and then showed an error would look identical from
    // the captured order alone. The whole address matters, not just its path —
    // a local page at the same path is not the payment page.
    const { STUB_CHECKOUT_URL } = await import("#test-utils/checkout.ts");
    expect(browser.redirectedTo).toBe(STUB_CHECKOUT_URL);
    return whatIsBeingCharged(whatWasCharged(), timesReached());
  });

/** The same code with its signed part meddled with, as anyone reading the link
 * off a poster could do. */
export const meddledWith = (link: string): string => {
  const found = link.match(/t=(.+)$/);
  if (!found?.[1]) throw new Error("That code carries nothing to meddle with");
  const code = found[1];
  // Change one character in the middle, leaving the shape of the code intact —
  // a link that still looks right but is not the one the site handed out.
  const at = Math.floor(code.length / 2);
  const swapped = code[at] === "A" ? "B" : "A";
  return link.replace(code, code.slice(0, at) + swapped + code.slice(at + 1));
};

/** The organiser takes something off sale after the codes are printed. */
export const takeOffSale = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const { listingsTable } = await import("#shared/db/listings/records.ts");
  await listingsTable.update(stayListing(world, name).id, { active: false });
};

/** Nothing at all was booked, whatever the page said. */
export const expectNothingBooked = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const { getAttendeesRaw } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  expect(await getAttendeesRaw(stayListing(world, name).id)).toEqual([]);
};
