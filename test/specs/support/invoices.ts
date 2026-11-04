/** The invoices an organiser sends for what a booking still owes, and the link
 *  the buyer is sent to read one. */

import {
  adminPageHtmlAt,
  keepsWhatTheOrganiserSaw,
  scenarioBrowser,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import { messagesSent, type SentMessage } from "#test/specs/support/contact.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  requiredWorldValue,
  type StoryJourney,
  type TicketsWorld,
  theBooking,
} from "#test/specs/support/world.ts";
import { regionOutOf } from "#test-utils/test-browser/parsing.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

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

/** Open the preview page for the booking the story is working on. A booking
 *  the site refuses stays on the create page, where the story reads what it
 *  said. */
const openInvoicePreview = async (world: TicketsWorld): Promise<TestBrowser> =>
  sendInvoiceForm(
    world,
    NEW_INVOICE,
    await invoiceCopy("invoices.action.preview"),
    { attendee_id: String(theBooking(world)) },
  );

/** The preview page for the story's booking, or null when the site refused the
 *  booking and stayed on the create page. Where the organiser landed is kept
 *  either way. */
const openPreviewOrRefusal = async (
  world: TicketsWorld,
): Promise<TestBrowser | null> => {
  const browser = await openInvoicePreview(world);
  if (browser.currentUrl === "/admin/invoices/preview") return browser;
  world.invoicePath = browser.currentUrl;
  return null;
};

/** Confirm the preview page, with the text the organiser kept when the story
 *  changed it. Where the organiser landed is kept. */
const confirmThePreview = async (
  world: TicketsWorld,
  text: string | null,
): Promise<void> => {
  const browser = await openPreviewOrRefusal(world);
  if (browser === null) return;
  const button = await invoiceCopy("invoices.action.create");
  if (text === null) {
    await browser.submitForm({}, button);
  } else {
    await fillInAndSend(browser, { body: text }, button);
  }
  keepsWhatTheOrganiserSaw(world, browser);
  world.invoicePath = browser.currentUrl;
};

/** Make an invoice for the booking the story is working on, through the form
 *  the site served. The first form shows the invoice text for review, and the
 *  second one makes it. When the story gives text, the invoice uses that text. */
export const sendInvoice: StoryJourney<[text?: string | null], void> = async (
  world,
  text = null,
) => {
  await confirmThePreview(world, text);
};

/** Show the preview page for the story's booking without making the invoice.
 *  What the page offers is kept for the story to read. */
export const previewInvoiceFor = async (world: TicketsWorld): Promise<void> => {
  if ((await openPreviewOrRefusal(world)) === null) {
    throw new Error(
      `The site did not show the preview page: ${world.invoicePath}`,
    );
  }
};

/** Change the invoice text on the preview page and press Update preview, so
 *  the story reads the invoice the new text makes. */
export const updateInvoicePreviewText: StoryJourney<[string], void> = async (
  world,
  text,
) => {
  const browser = scenarioBrowser(world);
  await fillInAndSend(
    browser,
    { body: text },
    await invoiceCopy("invoices.action.update_preview"),
  );
  keepsWhatTheOrganiserSaw(world, browser);
};

/** The invoice the preview page shows, from the box that bounds it. */
export const previewBoxOn = (browser: TestBrowser): string =>
  regionOutOf(
    browser.currentHtml,
    '<div class="prose email-preview">',
    "</div>",
    "the invoice preview box",
  );

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

/** Just the summary rows of one page, so a status cannot answer for some other
 *  word further down the page. */
export const detailsOnPage = (page: string, what: string): string => {
  const opened = page.indexOf('<table class="listing-details-table">');
  if (opened === -1) throw new Error(`${what} showed no summary rows`);
  const closed = page.indexOf("</table>", opened);
  if (closed === -1) throw new Error(`${what}'s summary never closed`);
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
