/** The stories about the invoices an organiser sends for what a booking owes. */

import { Given, Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { formatCurrency } from "#shared/currency.ts";
import {
  adminPageHtmlAt,
  newcomerReading,
  ORGANISER,
  openAdminPage,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import {
  cancelInvoice,
  detailsOnPage,
  invoiceCopy,
  invoiceEmail,
  invoiceLinkFromEmail,
  invoiceNumber,
  invoiceSays,
  invoicesListed,
  previewBoxOn,
  previewInvoiceFor,
  sendInvoice,
  updateInvoicePreviewText,
} from "#test/specs/support/invoices.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  theBooking,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

/** One action, told as the state before a scenario and as the act within it. */
const sendTheInvoice = function (this: TicketsWorld): Promise<void> {
  return sendInvoice(this);
};

Given("the organiser has sent that booking an invoice", sendTheInvoice);
When("the organiser sends that booking an invoice", sendTheInvoice);
When("the organiser sends that booking another invoice", sendTheInvoice);

/** Cancel the invoice the story last sent. */
const cancelTheInvoice = function (this: TicketsWorld): Promise<void> {
  return cancelInvoice(this);
};

When("the organiser cancels the invoice", cancelTheInvoice);

When(
  "the buyer opens the link from their email",
  async function (this: TicketsWorld): Promise<void> {
    const read = await newcomerReading(invoiceLinkFromEmail(this));
    expect(read.answered).toBe(200);
    this.buyerSaw = read.said;
  },
);

Then(
  "the invoice says {word} is due",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const due = await invoiceCopy("invoices.body.due");
    assertStringIncludes(
      await invoiceSays(this),
      `${due}: ${formatCurrency(minorUnits(amount))}`,
    );
  },
);

Then(
  "the buyer's email carries a link to the invoice",
  async function (this: TicketsWorld): Promise<void> {
    const sent = invoiceEmail(this);
    expect(sent.to).toEqual([
      requiredWorldValue(this.attendeeEmail, "the buyer's address"),
    ]);
    expect(sent.subject).toBe(
      await invoiceCopy("invoices.email.subject", {
        number: invoiceNumber(this),
      }),
    );
    expect(invoiceLinkFromEmail(this)).toContain("/invoice/");
  },
);

Then(
  "the site refuses it because the booking already has a new invoice",
  async function (this: TicketsWorld): Promise<void> {
    assertStringIncludes(
      whatTheyWereTold(this, ORGANISER),
      await invoiceCopy("invoices.error.open_invoice_exists"),
    );
  },
);

Then(
  "the booking still has one invoice",
  async function (this: TicketsWorld): Promise<void> {
    expect(await invoicesListed(this)).toBe(1);
  },
);

Then(
  "the site takes the second invoice as a new one",
  async function (this: TicketsWorld): Promise<void> {
    assertStringIncludes(
      detailsOnPage(await invoiceSays(this), "The invoice page"),
      await invoiceCopy("invoices.status.new"),
    );
  },
);

Then(
  "the invoice says it is paid",
  async function (this: TicketsWorld): Promise<void> {
    const details = detailsOnPage(await invoiceSays(this), "The invoice page");
    expectIncludesAll(details, [
      await invoiceCopy("invoices.column.status"),
      await invoiceCopy("invoices.status.paid"),
    ]);
    expect(details).not.toContain(await invoiceCopy("invoices.status.new"));
  },
);

Then(
  "the invoice says it is cancelled",
  async function (this: TicketsWorld): Promise<void> {
    assertStringIncludes(
      requiredWorldValue(this.buyerSaw, "the buyer's page"),
      await invoiceCopy("invoices.share.status", {
        status: await invoiceCopy("invoices.status.cancelled"),
      }),
    );
  },
);

Then(
  "it offers no way to pay",
  async function (this: TicketsWorld): Promise<void> {
    const said = requiredWorldValue(this.buyerSaw, "the buyer's page");
    // The pay button is a form that starts a checkout, so the address it posts
    // to is the whole affordance — a page without it offers no way to pay.
    expect(said).not.toContain("/pay/");
  },
);

/** Send the story's booking an invoice whose text the organiser changed on the
 *  preview page. */
When(
  "the organiser sends that booking an invoice with the text:",
  function (this: TicketsWorld, text: string): Promise<void> {
    return sendInvoice(this, text);
  },
);

When(
  "the organiser sends that booking an invoice with no text",
  function (this: TicketsWorld): Promise<void> {
    return sendInvoice(this, "");
  },
);

/** Open the preview page for the story's booking, keeping what it says. */
const previewTheInvoice = function (this: TicketsWorld): Promise<void> {
  return previewInvoiceFor(this);
};

When("the organiser previews an invoice for that booking", previewTheInvoice);

When(
  "the organiser changes the invoice text and updates the preview:",
  function (this: TicketsWorld, text: string): Promise<void> {
    return updateInvoicePreviewText(this, text);
  },
);

Then(
  "the preview shows the heading {string}",
  function (this: TicketsWorld, heading: string): void {
    assertStringIncludes(
      previewBoxOn(scenarioBrowser(this)),
      `<h1>${heading}</h1>`,
    );
  },
);

Then(
  "the booking has no invoice",
  async function (this: TicketsWorld): Promise<void> {
    expect(await invoicesListed(this)).toBe(0);
  },
);

Then(
  "the invoice text still says {string}",
  function (this: TicketsWorld, text: string): void {
    assertStringIncludes(whatTheyWereTold(this, ORGANISER), text);
  },
);

Then(
  "the invoice text no longer says {string}",
  function (this: TicketsWorld, text: string): void {
    expect(whatTheyWereTold(this, ORGANISER)).not.toContain(text);
  },
);

Then(
  "the preview shows the booking owes {word}",
  function (this: TicketsWorld, amount: string): void {
    assertStringIncludes(
      whatTheyWereTold(this, ORGANISER),
      `owes ${formatCurrency(minorUnits(amount))}`,
    );
  },
);

When(
  "the organiser opens the booking's own page",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, `/admin/attendees/${theBooking(this)}`);
  },
);

Then(
  "the booking's details name the invoice and its status",
  async function (this: TicketsWorld): Promise<void> {
    const details = detailsOnPage(
      await adminPageHtmlAt(this, `/admin/attendees/${theBooking(this)}`),
      "The booking's page",
    );
    expectIncludesAll(details, [
      `href="/admin/invoices/${invoiceNumber(this)}"`,
      await invoiceCopy("invoices.status.new"),
    ]);
  },
);
