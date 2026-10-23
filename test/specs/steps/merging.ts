// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { attendeeAccount, WRITEOFF } from "#accounting/accounts.ts";
import { accountBalance } from "#accounting/queries.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import {
  bundleBookingField,
  duplicatePair,
  duplicatePairOnSlots,
  keptBookingRows,
  mergeChoices,
  mergeDeciding,
  mergeDuplicates,
  mergedListingId,
  plainBookingField,
  survivorId,
} from "#test/specs/support/merging.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  adminPageHtml,
  incomeOf,
  norm,
  owedBy,
  sumOfAllBalances,
} from "#test/specs/support/money-reads.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

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
  "the organiser merges them and keeps it as credit for them",
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
    assertStringIncludes(outcome.message, "money decision");
  },
);

Then(
  "both bookings are still there, still counted",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = mergedListingId(this);
    // Nothing moved: both places still counted, and the books still balance.
    expect((await getAttendeesRaw(listingId)).length).toBe(2);
    expect(await incomeOf(listingId)).toBe(minorUnits("100.00"));
    expect(await sumOfAllBalances()).toBe(0);
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
    // However the money was decided, none of it may appear or vanish.
    expect(await sumOfAllBalances()).toBe(0);
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
    assertStringIncludes(page, formatCurrency(await owedBy(survivorId(this))));
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
    assertStringIncludes(html, 'name="booking_');
    assert(!html.includes("merge-money-decision"));
    assert(!html.includes("Discarded payment"));
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
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Given(
  "the same person paid twice for a {word} place, the incoming booking holding {int} place(s) and the opened one {int}",
  function (
    this: TicketsWorld,
    listing: string,
    incoming: number,
    opened: number,
  ): Promise<void> {
    return duplicatePairOnSlots(
      this,
      listing,
      {
        source: [{ quantity: incoming }],
        target: [{ quantity: opened }],
      },
      { paid: true },
    );
  },
);

Given(
  "the same person paid twice for a {word} stay starting {int} days from now, the incoming booking holding {int} place(s) over {int} day(s) and the opened one {int} place(s) over {int} day(s)",
  function (
    this: TicketsWorld,
    listing: string,
    startsIn: number,
    incoming: number,
    incomingDays: number,
    opened: number,
    openedDays: number,
  ): Promise<void> {
    const start = parseDateStringOrThrow(
      dayFromToday(this, startsIn),
      "the stay's first day",
    );
    this.stayStartsOn = start;
    return duplicatePairOnSlots(
      this,
      listing,
      {
        source: [
          { date: start, durationDays: incomingDays, quantity: incoming },
        ],
        target: [{ date: start, durationDays: openedDays, quantity: opened }],
      },
      { daily: true, paid: true },
    );
  },
);

Given(
  "the same person booked a free {word} place twice, each booking holding a place inside a bundle and one on its own, the incoming booking holding {int} place(s) and the opened one {int}",
  function (
    this: TicketsWorld,
    listing: string,
    incoming: number,
    opened: number,
  ): Promise<void> {
    return duplicatePairOnSlots(this, listing, {
      source: [{ bundle: true, quantity: incoming }, { quantity: incoming }],
      target: [{ bundle: true, quantity: opened }, { quantity: opened }],
    });
  },
);

When(
  "the organiser merges them, keeping the incoming booking and the opened one's money as credit",
  async function (this: TicketsWorld): Promise<void> {
    const [bookingField] = (await mergeChoices(this)).bookingFields;
    this.mergeOutcome = await mergeDeciding(this, [
      { choice: "take_source", field: bookingField!, money: "credit" },
    ]);
  },
);

When(
  "the organiser merges them keeping the incoming bundle part",
  async function (this: TicketsWorld): Promise<void> {
    const { bookingFields } = await mergeChoices(this);
    this.mergeOutcome = await mergeDeciding(this, [
      { choice: "take_source", field: bundleBookingField(bookingFields) },
      { choice: "keep_target", field: plainBookingField(bookingFields) },
    ]);
  },
);

Then(
  "the {word} counts one booking holding {int} place(s) and no days",
  async function (
    this: TicketsWorld,
    _listing: string,
    places: number,
  ): Promise<void> {
    expect(await keptBookingRows(this)).toEqual([
      { end_at: null, package_group_id: 0, quantity: places, start_at: null },
    ]);
  },
);

Then(
  "the booking they keep holds {int} place(s) over those {int} day(s)",
  async function (
    this: TicketsWorld,
    places: number,
    days: number,
  ): Promise<void> {
    const start = parseDateStringOrThrow(
      requiredWorldValue(this.stayStartsOn, "the stay's first day"),
      "the stay's first day",
    );
    const rows = await keptBookingRows(this);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The row stores the day boundaries; the story's own numbers are the days
    // themselves: a 2-day stay starting D runs D and D+1, bounded by D+2.
    expect(String(row.start_at).slice(0, 10)).toBe(start);
    expect(String(row.end_at).slice(0, 10)).toBe(addDays(start, days));
    expect(row.package_group_id).toBe(0);
    expect(row.quantity).toBe(places);
  },
);

Then(
  "the bundle part is the incoming one and the on-its-own booking is the one they opened",
  async function (this: TicketsWorld): Promise<void> {
    const rows = await keptBookingRows(this);
    const bundled = rows.filter((row) => row.package_group_id !== 0);
    const plain = rows.filter((row) => row.package_group_id === 0);
    expect(bundled).toHaveLength(1);
    expect(bundled[0]!.quantity).toBe(2);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.quantity).toBe(1);
  },
);
