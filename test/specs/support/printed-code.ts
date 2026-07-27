/**
 * Booking from a code the organiser prints out. The organiser fills in the
 * listing's own "make a booking code" page and gets back a link; a customer
 * follows that link. Both halves go through the real pages, so the story is
 * always using a code the site itself would hand out.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { rememberStayListing, stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite, setupStripe } from "#test-utils/settings.ts";

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

/** The organiser makes a printed code for something, through the page that
 * makes them. The link it gives back is the whole point, so a page that stops
 * producing one fails the story here. */
export const organiserMakesCode = async (
  world: TicketsWorld,
  name: string,
  wanted: CodeWanted = {},
): Promise<string> => {
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
  return link[0].replaceAll("&amp;", "&");
};

/** Where a printed code took the customer. Either it carried everything and
 * they went straight off to pay, or they landed on a page to fill in. */
export interface WhereTheCodeLed {
  /** The page they landed on, when they were not. */
  page: string;
  /** What paying would have charged for one place, when they were sent to pay. */
  priceEach: number | null;
  /** Whether the site could open anything for them at all. */
  reached: boolean;
  sentToPay: boolean;
}

/** A customer follows a printed code. Paying is stubbed at the provider, so the
 * story can see what the customer would have been charged without a real
 * checkout. */
export const customerFollows = async (
  link: string,
): Promise<WhereTheCodeLed> => {
  const { stubCheckout, STUB_CHECKOUT_URL } = await import(
    "#test-utils/checkout.ts"
  );
  const { handleRequest } = await import("#routes");
  const { mockProviderType, mockRequest, withMocks } = await import(
    "#test-utils/mocks.ts"
  );
  const { paymentsApi } = await import("#shared/payments.ts");
  let led: WhereTheCodeLed | undefined;
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const checkout = stubCheckout();
      try {
        const response = await handleRequest(mockRequest(link));
        const sentToPay =
          response.status === 302 &&
          (response.headers.get("location") ?? "").startsWith(
            STUB_CHECKOUT_URL,
          );
        led = {
          page: sentToPay ? "" : await response.text(),
          priceEach: sentToPay
            ? (checkout.getCaptured()?.items[0]?.unitPrice ?? null)
            : null,
          reached: response.status !== 404,
          sentToPay,
        };
        if (sentToPay) response.body?.cancel();
      } finally {
        checkout.checkout.restore();
      }
    },
  );
  if (!led) throw new Error("Following the code led nowhere");
  return led;
};

/** The customer decides to pay more than the code says, on the form the code
 * opened for them, and books. The code is carried through from that page's own
 * hidden field, which is how the customer's browser would carry it. */
export const customerPaysMore = async (
  world: TicketsWorld,
  name: string,
  page: string,
  price: number,
): Promise<number | null> => {
  const carried = page.match(/name="qr_token"[^>]*value="([^"]*)"/);
  if (!carried?.[1]) throw new Error("The form is not carrying the code");
  const { stubCheckout } = await import("#test-utils/checkout.ts");
  const { submitTicketForm } = await import("#test-utils/csrf.ts");
  const { mockProviderType, withMocks } = await import("#test-utils/mocks.ts");
  const { paymentsApi } = await import("#shared/payments.ts");
  let charged: number | null = null;
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const checkout = stubCheckout();
      try {
        const response = await submitTicketForm(stayListing(world, name).slug, {
          custom_price: price.toFixed(2),
          email: "buyer@example.com",
          name: "Ada",
          qr_token: carried[1] as string,
          quantity: "1",
        });
        expect(response.status).toBe(302);
        response.body?.cancel();
        charged = checkout.getCaptured()?.items[0]?.unitPrice ?? null;
      } finally {
        checkout.checkout.restore();
      }
    },
  );
  return charged;
};

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
