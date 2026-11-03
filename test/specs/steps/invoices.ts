/** The stories about the bills an organiser issues for what a booking owes. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { formatCurrency } from "#shared/currency.ts";
import { newcomerReading, ORGANISER } from "#test/specs/support/browser.ts";
import {
  billDetailsIn,
  billEmail,
  billNumber,
  billSays,
  billsListed,
  buyerLinkFromEmail,
  cancelBill,
  invoiceCopy,
  sendBill,
} from "#test/specs/support/invoices.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** One action, told as the state before a scenario and as the act within it. */
const sendTheBill = function (this: TicketsWorld): Promise<void> {
  return sendBill(this);
};

Given("the organiser has sent that booking a bill", sendTheBill);
When("the organiser sends that booking a bill", sendTheBill);

When("the organiser sends that booking another bill", sendTheBill);

/** Cancel the bill the story last issued. */
const cancelTheBill = function (this: TicketsWorld): Promise<void> {
  return cancelBill(this);
};

When("the organiser cancels the bill", cancelTheBill);

When(
  "the buyer opens the link from their email",
  async function (this: TicketsWorld): Promise<void> {
    const read = await newcomerReading(buyerLinkFromEmail(this));
    expect(read.answered).toBe(200);
    this.buyerSaw = read.said;
  },
);

Then(
  "the bill says {word} is due",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const due = await invoiceCopy("invoices.body.due");
    assertStringIncludes(
      await billSays(this),
      `${due}: ${formatCurrency(minorUnits(amount))}`,
    );
  },
);

Then(
  "the buyer's email carries a link to the bill",
  async function (this: TicketsWorld): Promise<void> {
    const sent = billEmail(this);
    expect(sent.to).toEqual([
      requiredWorldValue(this.attendeeEmail, "the buyer's address"),
    ]);
    expect(sent.subject).toBe(
      await invoiceCopy("invoices.email.subject", { number: billNumber(this) }),
    );
    expect(buyerLinkFromEmail(this)).toContain("/invoice/");
  },
);

Then(
  "the site refuses it because the booking already has a new bill",
  async function (this: TicketsWorld): Promise<void> {
    assertStringIncludes(
      whatTheyWereTold(this, ORGANISER),
      await invoiceCopy("invoices.error.open_invoice_exists"),
    );
  },
);

Then(
  "the booking still has one bill",
  async function (this: TicketsWorld): Promise<void> {
    expect(await billsListed(this)).toBe(1);
  },
);

Then(
  "the site takes the second bill as a new one",
  async function (this: TicketsWorld): Promise<void> {
    assertStringIncludes(
      billDetailsIn(await billSays(this)),
      await invoiceCopy("invoices.status.new"),
    );
  },
);

Then(
  "the bill says it is paid",
  async function (this: TicketsWorld): Promise<void> {
    const details = billDetailsIn(await billSays(this));
    assertStringIncludes(details, await invoiceCopy("invoices.column.status"));
    assertStringIncludes(details, await invoiceCopy("invoices.status.paid"));
    expect(details).not.toContain(await invoiceCopy("invoices.status.new"));
  },
);

Then(
  "the bill says it is cancelled",
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
