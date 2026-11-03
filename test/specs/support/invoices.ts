/** The bills an organiser issues for what a booking still owes, and the link
 *  the buyer is sent to read one. */

// jscpd:ignore-start

import {
  adminPageHtmlAt,
  keepsWhatTheOrganiserSaw,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import { messagesSent, type SentMessage } from "#test/specs/support/contact.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  theBooking,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** What the site says about invoices. */
export const invoiceCopy = copyFrom("invoices");

/** Where a bill is issued from, and where the list of them lives. */
const NEW_BILL = "/admin/invoices/new";
const BILL_LIST = "/admin/invoices";

/** The bill the story last issued, as an address. */
export const billPath = (world: TicketsWorld): string =>
  requiredWorldValue(world.invoicePath, "the bill's address");

/** The number the site filed the last bill under, read from its own address. */
export const billNumber = (world: TicketsWorld): number => {
  const matched = billPath(world).match(/\/admin\/invoices\/(\d+)$/);
  const number = matched?.[1];
  if (number === undefined) {
    throw new Error(`No bill number in ${billPath(world)}`);
  }
  return Number(number);
};

/** Send one bill's form and keep what the organiser saw, handing the window
 *  back for a caller that needs where it landed. */
const sendBillForm = async (
  world: TicketsWorld,
  path: string,
  button: string,
  values: Record<string, string> = {},
): Promise<TestBrowser> => {
  const browser = await submitRenderedAdminForm(world, path, button, values);
  keepsWhatTheOrganiserSaw(world, browser);
  return browser;
};

/** Issue a bill for the booking the story is working on, through the form the
 *  site served, and keep where the organiser landed. */
export const sendBill = async (world: TicketsWorld): Promise<void> => {
  const browser = await sendBillForm(
    world,
    NEW_BILL,
    await invoiceCopy("invoices.action.create"),
    { attendee_id: String(theBooking(world)) },
  );
  world.invoicePath = browser.currentUrl;
};

/** Cancel the last bill from its own page. */
export const cancelBill = async (world: TicketsWorld): Promise<void> => {
  await sendBillForm(
    world,
    billPath(world),
    await invoiceCopy("invoices.action.cancel"),
  );
};

/** What the bill page says now, read fresh. */
export const billSays = (world: TicketsWorld): Promise<string> =>
  adminPageHtmlAt(world, billPath(world));

/** Just the summary rows of a bill page, so a status cannot answer for some
 *  other word further down the page. */
export const billDetailsIn = (page: string): string => {
  const opened = page.indexOf('<table class="listing-details-table">');
  if (opened === -1) throw new Error("The bill page showed no summary rows");
  const closed = page.indexOf("</table>", opened);
  if (closed === -1) throw new Error("The bill page's summary never closed");
  return page.slice(opened, closed);
};

/** The last message the site sent, which is the one the story just caused. */
export const billEmail = (world: TicketsWorld): SentMessage => {
  const sent = messagesSent(world).at(-1);
  if (sent === undefined) throw new Error("The site sent no email to read");
  return sent;
};

/** The bill link out of the message the site sent the buyer. */
export const buyerLinkFromEmail = (world: TicketsWorld): string => {
  const link = billEmail(world).html?.match(/\/invoice\/[A-Za-z0-9_-]+/)?.[0];
  if (link === undefined) throw new Error("The bill email carried no link");
  return link;
};

/** How many bills the list page names. */
export const billsListed = async (world: TicketsWorld): Promise<number> => {
  const links = (await adminPageHtmlAt(world, BILL_LIST)).match(
    /href="\/admin\/invoices\/\d+"/g,
  );
  return links === null ? 0 : links.length;
};
