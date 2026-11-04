/** The invoices an organiser sends for what a booking still owes, and the link
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

/** Where an invoice is made from, and where the list of them lives. */
const NEW_INVOICE = "/admin/invoices/new";
const INVOICE_LIST = "/admin/invoices";

/** The invoice the story last sent, as an address. */
export const invoiceAddress = (world: TicketsWorld): string =>
  requiredWorldValue(world.invoicePath, "the invoice's address");

/** The number the site filed the last invoice under, read from its own
 *  address. */
export const invoiceNumber = (world: TicketsWorld): number => {
  const matched = invoiceAddress(world).match(/\/admin\/invoices\/(\d+)$/);
  const number = matched?.[1];
  if (number === undefined) {
    throw new Error(`No invoice number in ${invoiceAddress(world)}`);
  }
  return Number(number);
};

/** Send one invoice form and keep what the organiser saw, handing the window
 *  back for a caller that needs where it landed. */
const sendInvoiceForm = async (
  world: TicketsWorld,
  path: string,
  button: string,
  values: Record<string, string> = {},
): Promise<TestBrowser> => {
  const browser = await submitRenderedAdminForm(world, path, button, values);
  keepsWhatTheOrganiserSaw(world, browser);
  return browser;
};

/** Make an invoice for the booking the story is working on, through the form
 *  the site served. The first form shows the invoice text for review, and the
 *  second one makes it. A booking the site refuses stays on the create page,
 *  where the story reads what it said. Where the organiser landed is kept. */
export const sendInvoice = async (world: TicketsWorld): Promise<void> => {
  const browser = await sendInvoiceForm(
    world,
    NEW_INVOICE,
    await invoiceCopy("invoices.action.preview"),
    { attendee_id: String(theBooking(world)) },
  );
  if (browser.currentUrl !== "/admin/invoices/preview") {
    world.invoicePath = browser.currentUrl;
    return;
  }
  await browser.submitForm({}, await invoiceCopy("invoices.action.create"));
  keepsWhatTheOrganiserSaw(world, browser);
  world.invoicePath = browser.currentUrl;
};

/** Cancel the last invoice from its own page. */
export const cancelInvoice = async (world: TicketsWorld): Promise<void> => {
  await sendInvoiceForm(
    world,
    invoiceAddress(world),
    await invoiceCopy("invoices.action.cancel"),
  );
};

/** What the invoice page says now, read fresh. */
export const invoiceSays = (world: TicketsWorld): Promise<string> =>
  adminPageHtmlAt(world, invoiceAddress(world));

/** Just the summary rows of an invoice page, so a status cannot answer for
 *  some other word further down the page. */
export const invoiceDetailsIn = (page: string): string => {
  const opened = page.indexOf('<table class="listing-details-table">');
  if (opened === -1) throw new Error("The invoice page showed no summary rows");
  const closed = page.indexOf("</table>", opened);
  if (closed === -1) {
    throw new Error("The invoice page's summary never closed");
  }
  return page.slice(opened, closed);
};

/** The last message the site sent, which is the one the story just caused. */
export const invoiceEmail = (world: TicketsWorld): SentMessage => {
  const sent = messagesSent(world).at(-1);
  if (sent === undefined) throw new Error("The site sent no email to read");
  return sent;
};

/** The link to the invoice out of the message the site sent the buyer. */
export const invoiceLinkFromEmail = (world: TicketsWorld): string => {
  const link = invoiceEmail(world).html?.match(
    /\/invoice\/[A-Za-z0-9_-]+/,
  )?.[0];
  if (link === undefined) throw new Error("The email carried no invoice link");
  return link;
};

/** How many invoices the list page names. */
export const invoicesListed = async (world: TicketsWorld): Promise<number> => {
  const links = (await adminPageHtmlAt(world, INVOICE_LIST)).match(
    /href="\/admin\/invoices\/\d+"/g,
  );
  return links === null ? 0 : links.length;
};
