// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { formatSignedCurrency } from "#shared/currency.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  askForRefund,
  bookingId,
  buyOnePlace,
  expectRefundMessage,
  listingIdFor,
  sellPlacesAt,
  timesProviderWasAsked,
} from "#test/specs/support/money.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { singleItem } from "#test-utils/factories.ts";
import { withStripeSuccess } from "#test-utils/money/drivers.ts";
import {
  adminPageHtml,
  incomeLedgerArticle,
  incomeOf,
  kindsOf,
  legsOfKind,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test-utils/money/reads.ts";

// jscpd:ignore-end

const FREE_MEETUP = "Free Meetup";
const SHOW = "Show";
const REPEAT = "Repeat";
const RECONCILED = "Reconciled";

/** Set a listing's income through the correction form on its own edit page, and
 * check the organiser is told it worked — a failed save redirects too, so a bare
 * redirect would not show the difference. */
const correctIncomeTo = async (
  world: TicketsWorld,
  listingId: number,
  pounds: string,
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${listingId}/edit`);
  // The page must offer the correction box; the browser posts the form's own
  // action and token, so a broken form fails here.
  expect(browser.currentHtml).toContain('id="income"');
  await browser.submitForm({ income: pounds }, "Save income correction");
  expect(browser.containsText("Listing income corrected.")).toBe(true);
};

/** The amount shown on one row of the money breakdown, found by that row's own
 * label — so a figure belonging to a different row can never satisfy a check. */
const breakdownRowAmount = (breakdown: string, label: string): string => {
  const row = breakdown.match(
    new RegExp(
      `<th[^>]*>(?:<strong>)?${label}(?:</strong>)?</th>\\s*<td[^>]*>(?:<strong>)?([^<]*)`,
    ),
  );
  if (!row) throw new Error(`the breakdown has no ${label} row`);
  return row[1]!;
};

When(
  "a customer books a free Free Meetup place",
  async function (this: TicketsWorld): Promise<void> {
    const listing = await sellPlacesAt(this, FREE_MEETUP, "0.00");
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Free Guest",
      "free@example.com",
    );
    this.attendeeId = attendee.id;
    this.attendeeName = "Free Guest";
  },
);

Then(
  "no money is recorded for the booking",
  async function (this: TicketsWorld): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(
      (await transfersByAccount(attendeeAccount(bookingId(this)))).length,
    ).toBe(0);
    expect(await incomeOf(listingIdFor(this, FREE_MEETUP))).toBe(0);
  },
);

Then("no booking fee is recorded", async (): Promise<void> => {
  expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
  expect(await worldBalance()).toBe(0);
  expect(await sumOfAllBalances()).toBe(0);
});

Given(
  "a customer paid 45.00 for a Show place",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, SHOW, "45.00", "No Refund");
    expect(await incomeOf(listingIdFor(this, SHOW))).toBe(4500);
  },
);

When(
  "the organiser asks for a refund and the provider turns it down",
  function (this: TicketsWorld): Promise<void> {
    return askForRefund(this, false);
  },
);

Then(
  "the organiser is told the refund failed",
  async function (this: TicketsWorld): Promise<void> {
    expectRefundMessage(
      this,
      `/admin/attendees/${bookingId(this)}/refund`,
      "Refund failed",
    );
    expect(timesProviderWasAsked(this)).toBe(1);
  },
);

Then(
  "the Show has still earned 45.00 and no money was handed back",
  async function (this: TicketsWorld): Promise<void> {
    expect(await incomeOf(listingIdFor(this, SHOW))).toBe(4500);
    expect(await owedBy(bookingId(this))).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(legsOfKind(legs, "refund_cash").length).toBe(0);
    expect(kindsOf(legs)).toEqual(["payment", "sale"]);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Given(
  "a customer paid 60.00 for a Repeat place",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, REPEAT, "60.00", "Repeat Buyer");
  },
);

When(
  "the same payment message arrives again",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, REPEAT);
    // An already-handled payment is a no-op, so the page just renders again.
    await withStripeSuccess(
      {
        email: "repeat.buyer@example.com",
        items: singleItem(listingId, 1, 6000),
        name: "Repeat Buyer",
        paymentIntent: "pi_repeat",
        sessionId: "cs_repeat",
        total: 6000,
      },
      async (replay) => {
        await replay.body?.cancel();
      },
    );
  },
);

Then(
  "there is still one booking and one sale",
  async function (this: TicketsWorld): Promise<void> {
    expect((await getAttendeesRaw(listingIdFor(this, REPEAT))).length).toBe(1);
    expect(
      kindsOf(await transfersByAccount(attendeeAccount(bookingId(this)))),
    ).toEqual(["payment", "sale"]);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

When(
  "the organiser sets the Repeat income to 40.00 twice",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, REPEAT);
    await correctIncomeTo(this, listingId, "40.00");
    await correctIncomeTo(this, listingId, "40.00");
  },
);

Then(
  "the Repeat has earned 40.00 from a single correction",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, REPEAT);
    expect(await incomeOf(listingId)).toBe(4000);
    // The second save works out a change of nothing, so it records nothing.
    const corrections = legsOfKind(
      await transfersByAccount(revenueAccount(listingId)),
      "adjustment",
    );
    expect(corrections.length).toBe(1);
  },
);

Given(
  "a customer paid 50.00 for a Reconciled place",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, RECONCILED, "50.00", "Recon Buyer");
  },
);

Given(
  "the organiser corrected the Reconciled income to 40.00",
  function (this: TicketsWorld): Promise<void> {
    return correctIncomeTo(this, listingIdFor(this, RECONCILED), "40.00");
  },
);

Then(
  "the Reconciled page breaks the money down line by line",
  async function (this: TicketsWorld): Promise<void> {
    const breakdown = incomeLedgerArticle(
      await adminPageHtml(`/admin/listing/${listingIdFor(this, RECONCILED)}`),
    );
    expect(breakdown).toContain("Money in and out");
    // Each figure is read from its own row: the 50.00 sale, the 10.00 taken off
    // by the correction, the 40.00 that leaves as earned income, the 50.00
    // handed back, and the 10.00 the listing is down overall.
    const amountOn = (label: string): string =>
      breakdownRowAmount(breakdown, label);
    expect(amountOn("Gross ticket sales")).toBe(formatSignedCurrency(5000));
    expect(amountOn("Income corrections")).toBe(formatSignedCurrency(-1000));
    // The two subtotal rows drop a leading plus but keep a real minus.
    expect(amountOn("Total income earned")).toBe(
      formatSignedCurrency(4000, false),
    );
    expect(amountOn("Refunds")).toBe(formatSignedCurrency(-5000));
    expect(amountOn("Net after refunds and costs")).toBe(
      formatSignedCurrency(-1000, false),
    );
  },
);

Then(
  "the breakdown links to the Reconciled money record",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, RECONCILED);
    expect(
      incomeLedgerArticle(await adminPageHtml(`/admin/listing/${listingId}`)),
    ).toContain(`/admin/ledger?listing=${listingId}`);
  },
);
