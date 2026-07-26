// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { csvDateRange } from "#routes/admin/attendees-csv.ts";
import {
  downloadAttendeeList,
  organiserAddsBooking,
} from "#test/specs/support/by-hand.ts";
import {
  dayFromToday,
  guest,
  newestStayOn,
  staysOn,
} from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The list the organiser downloaded, as the file's own text. */
const downloadedList = (world: TicketsWorld): string =>
  requiredWorldValue(world.firstBody, "the downloaded list");

/** The date column the site writes for a stay between two days, so a story
 * checks the real column rather than a hand-built copy of it. */
const columnFor = (world: TicketsWorld, from: number, to: number): string =>
  csvDateRange(dayFromToday(world, from), dayFromToday(world, to + 1));

When(
  "the organiser adds a {word} booking starting in {int} days",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    const before = (await staysOn(this, name)).length;
    this.stayStartsOn = dayFromToday(this, startsIn);
    await organiserAddsBooking(this, name, {
      ...guest(6),
      day: this.stayStartsOn,
    });
    const booked = await staysOn(this, name);
    this.bookingWasTaken = booked.length > before;
    if (this.bookingWasTaken) this.attendeeId = await newestStayOn(this, name);
  },
);

Then(
  "the organiser is told the days have no room",
  function (this: TicketsWorld): void {
    expect(this.bookingWasTaken).toBe(false);
  },
);

Then(
  "no new {word} booking was added",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // The one stay the customer made, and nothing the refused attempt left
    // behind.
    expect((await staysOn(this, name)).length).toBe(1);
  },
);

When(
  "the organiser downloads the {word} list",
  async function (this: TicketsWorld, name: string): Promise<void> {
    this.firstBody = await downloadAttendeeList(this, name);
  },
);

Then(
  "the list shows that stay running from day {int} to day {int}",
  function (this: TicketsWorld, from: number, to: number): void {
    expect(downloadedList(this)).toContain(columnFor(this, from, to));
  },
);

Then(
  "the list never shows the stay running to day {int}",
  function (this: TicketsWorld, to: number): void {
    // The longest stay the listing allows must not appear in place of the days
    // the customer actually chose.
    expect(downloadedList(this)).not.toContain(columnFor(this, 10, to));
  },
);

Then(
  "the list shows that booking on day {int} alone",
  function (this: TicketsWorld, day: number): void {
    const list = downloadedList(this);
    expect(list).toContain(dayFromToday(this, day));
    // A single day is never written as a range.
    expect(list).not.toContain(" to ");
  },
);
