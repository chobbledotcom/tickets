/** The stories about the invoices an organiser sends for what a booking owes. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { formatCurrency } from "#shared/currency.ts";
import { newcomerReading, ORGANISER } from "#test/specs/support/browser.ts";
import {
  cancelInvoice,
  invoiceCopy,
  invoiceDetailsIn,
  invoiceEmail,
  invoiceLinkFromEmail,
  invoiceNumber,
  invoiceSays,
  invoicesListed,
  sendInvoice,
} from "#test/specs/support/invoices.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

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
      invoiceDetailsIn(await invoiceSays(this)),
      await invoiceCopy("invoices.status.new"),
    );
  },
);

Then(
  "the invoice says it is paid",
  async function (this: TicketsWorld): Promise<void> {
    const details = invoiceDetailsIn(await invoiceSays(this));
    assertStringIncludes(details, await invoiceCopy("invoices.column.status"));
    assertStringIncludes(details, await invoiceCopy("invoices.status.paid"));
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
    expect(said).not.toContain("/pay/");
    expect(said).not.toContain(await invoiceCopy("invoices.share.pay"));
  },
);
