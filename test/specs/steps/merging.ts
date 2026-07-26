// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { attendeeAccount, WRITEOFF } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  duplicatePair,
  mergeChoices,
  mergeDuplicates,
  mergedListingId,
  survivorId,
} from "#test/specs/support/merging.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  adminPageHtml,
  incomeOf,
  norm,
  owedBy,
} from "#test-utils/money/reads.ts";

// jscpd:ignore-end

Given(
  "the same person paid twice for a {word} place",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return duplicatePair(this, listing, { paid: true });
  },
);

Given(
  "the same person booked a free {word} place twice",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return duplicatePair(this, listing, { paid: false });
  },
);

When(
  "the organiser merges them without saying what to do with the money",
  async function (this: TicketsWorld): Promise<void> {
    this.mergeOutcome = await mergeDuplicates(this);
  },
);

When(
  "the organiser merges them and hands the money back",
  async function (this: TicketsWorld): Promise<void> {
    this.mergeOutcome = await mergeDuplicates(this, "credit");
  },
);

When(
  "the organiser merges them and keeps the money",
  async function (this: TicketsWorld): Promise<void> {
    this.writeoffBefore = norm(await accountBalance(WRITEOFF));
    this.mergeOutcome = await mergeDuplicates(this, "writeoff");
  },
);

When(
  "the organiser looks at merging them",
  async function (this: TicketsWorld): Promise<void> {
    this.mergePreviewHtml = (await mergeChoices(this)).html;
  },
);

Then(
  "the organiser is told a money decision is needed",
  function (this: TicketsWorld): void {
    const outcome = requiredWorldValue(this.mergeOutcome, "the merge outcome");
    expect(outcome.applied).toBe(false);
    expect(outcome.message).toContain("money decision");
  },
);

Then(
  "both bookings are still there, still counted",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = mergedListingId(this);
    // Nothing moved: both places still counted, and the books still balance.
    expect((await getAttendeesRaw(listingId)).length).toBe(2);
    expect(await incomeOf(listingId)).toBe(minorUnits("100.00"));
  },
);

Then(
  "the {word} counts one place, at {word}",
  async function (
    this: TicketsWorld,
    _listing: string,
    amount: string,
  ): Promise<void> {
    expect(await incomeOf(mergedListingId(this))).toBe(minorUnits(amount));
  },
);

Then(
  "the booking they keep holds {word} of credit",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    // Credit reads as a negative amount owed: the site owes them.
    expect(await owedBy(survivorId(this))).toBe(-minorUnits(amount));
    expect(
      norm(
        await accountBalance(
          attendeeAccount(requiredWorldValue(this.duplicateId, "duplicate")),
        ),
      ),
    ).toBe(0);
  },
);

Then(
  "the credit is shown on their money page",
  async function (this: TicketsWorld): Promise<void> {
    const page = await adminPageHtml(
      `/admin/attendees/${survivorId(this)}/ledger`,
    );
    expect(page).toContain(formatCurrency(await owedBy(survivorId(this))));
  },
);

Then("the person is owed nothing", async function (this: TicketsWorld) {
  expect(await owedBy(survivorId(this))).toBe(0);
});

Then(
  "the extra {word} is written off",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const before = requiredWorldValue(this.writeoffBefore, "write-off before");
    expect(norm(await accountBalance(WRITEOFF))).toBe(
      before + minorUnits(amount),
    );
  },
);

Then(
  "they are not asked what to do with any money",
  function (this: TicketsWorld): void {
    const html = requiredWorldValue(this.mergePreviewHtml, "the merge page");
    // The conflicting booking is offered, but no money question comes with it.
    expect(html).toContain('name="booking_');
    expect(html).not.toContain("merge-money-decision");
    expect(html).not.toContain("Discarded payment");
  },
);

Then(
  "merging leaves one booking and no money moved",
  async function (this: TicketsWorld): Promise<void> {
    const outcome = await mergeDuplicates(this);
    expect(outcome.applied).toBe(true);
    const listingId = mergedListingId(this);
    expect((await getAttendeesRaw(listingId)).length).toBe(1);
    expect(await incomeOf(listingId)).toBe(0);
  },
);
