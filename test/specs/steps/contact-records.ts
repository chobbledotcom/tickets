// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  boxShows,
  contactWithHistory,
  openRecord,
  recordFor,
  saveRecord,
  unreadableRecord,
} from "#test/specs/support/contact-records.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Everyone a story talks about has an email the site files them under. */
const emailFor = (who: string): string => `${who.toLowerCase()}@example.com`;

/** Bookings the organiser took by hand, seeded on the record that cannot be
 * read. Repairing the note must leave this count alone too. */
const HAND_BOOKINGS = 2;

/** The record page the organiser is looking at. */
const recordPage = (world: TicketsWorld): TestBrowser =>
  requiredWorldValue(world.customerBrowser, "the record page");

Given(
  "the site has seen {word} book {int} times and get in touch {int} times",
  function (
    this: TicketsWorld,
    who: string,
    booked: number,
    messages: number,
  ): Promise<void> {
    return contactWithHistory(emailFor(who), {
      bookedByHand: 2,
      bookedThroughTheSite: booked,
      lastContacted: "2026-06-01T10:00:00.000Z",
      messages,
      note: `**VIP** ${who}`,
      visits: 9,
    });
  },
);

Given(
  "the site has a note about {word} saying {string}",
  function (this: TicketsWorld, who: string, note: string): Promise<void> {
    return contactWithHistory(emailFor(who), {
      bookedByHand: 0,
      bookedThroughTheSite: 0,
      lastContacted: "",
      messages: 0,
      note,
      visits: 0,
    });
  },
);

Given(
  "{word}'s record cannot be read, but says {int} site bookings and {int} visits",
  function (
    this: TicketsWorld,
    who: string,
    booked: number,
    visits: number,
  ): Promise<void> {
    return unreadableRecord(emailFor(who), {
      bookedByHand: HAND_BOOKINGS,
      bookedThroughTheSite: booked,
      visits,
    });
  },
);

When(
  "the organiser opens {word}'s record",
  async function (this: TicketsWorld, who: string): Promise<void> {
    this.customerBrowser = await openRecord(this, emailFor(who));
  },
);

When(
  "the organiser sets {word}'s messages to {int}",
  async function (
    this: TicketsWorld,
    who: string,
    messages: number,
  ): Promise<void> {
    this.customerBrowser = await saveRecord(this, emailFor(who), {
      messages: String(messages),
    });
  },
);

When(
  "the organiser sets {word}'s bookings to {int} and note to {string}",
  async function (
    this: TicketsWorld,
    who: string,
    booked: number,
    note: string,
  ): Promise<void> {
    this.customerBrowser = await saveRecord(this, emailFor(who), {
      bookedThroughTheSite: String(booked),
      note,
    });
  },
);

When(
  "the organiser leaves {word}'s site bookings blank",
  async function (this: TicketsWorld, who: string): Promise<void> {
    this.customerBrowser = await saveRecord(this, emailFor(who), {
      bookedThroughTheSite: "",
    });
  },
);

When(
  "the organiser saves {word}'s record again with the note {string}",
  async function (
    this: TicketsWorld,
    who: string,
    note: string,
  ): Promise<void> {
    // Resubmitting what the page already showed, which is what an organiser
    // pressing Save on the repaired form actually sends.
    const page = recordPage(this);
    expect(page.currentHtml).toContain('name="admin_notes"');
    this.customerBrowser = await saveRecord(this, emailFor(who), { note });
  },
);

Then(
  "the record shows {word} booked {int} times through the site",
  function (this: TicketsWorld, _who: string, booked: number): void {
    boxShows(recordPage(this), "bookedThroughTheSite", String(booked));
  },
);

Then(
  "the record shows {int} bookings the organiser added for {word}",
  function (this: TicketsWorld, added: number, _who: string): void {
    boxShows(recordPage(this), "bookedByHand", String(added));
  },
);

Then(
  "the record shows {word} has visited {int} times",
  function (this: TicketsWorld, _who: string, visits: number): void {
    boxShows(recordPage(this), "visits", String(visits));
  },
);

Then(
  "the record shows the note about {word} written out",
  function (this: TicketsWorld, who: string): void {
    // The note is kept as the organiser typed it and shown made-up, so bold
    // stays bold rather than arriving as raw markup.
    expect(recordPage(this).currentHtml).toContain(
      `<strong>VIP</strong> ${who}`,
    );
  },
);

Then(
  "the record shows nothing was ever counted",
  function (this: TicketsWorld): void {
    // Every count, not just the two the page happens to show first.
    boxShows(recordPage(this), "visits", "0");
    boxShows(recordPage(this), "bookedThroughTheSite", "0");
    boxShows(recordPage(this), "bookedByHand", "0");
    boxShows(recordPage(this), "messages", "0");
  },
);

Then(
  "the record says they have never been in touch",
  function (this: TicketsWorld): void {
    expect(recordPage(this).containsText("Never")).toBe(true);
  },
);

/** The note the site has kept about them, however the story words the check. */
const expectNoteKept = async function (
  this: TicketsWorld,
  who: string,
  note: string,
): Promise<void> {
  expect((await recordFor(emailFor(who))).adminNotes).toBe(note);
};

Then("the note kept about {word} is {string}", expectNoteKept);
Then("the note kept about {word} is still {string}", expectNoteKept);

Then(
  "the record shows {word} has been in touch {int} times",
  function (this: TicketsWorld, _who: string, messages: number): void {
    boxShows(recordPage(this), "messages", String(messages));
  },
);

Then(
  "{word} is counted as having been in touch {int} times",
  async function (
    this: TicketsWorld,
    who: string,
    messages: number,
  ): Promise<void> {
    expect((await recordFor(emailFor(who))).contactCount).toBe(messages);
  },
);

Then(
  "{word} is counted as having booked no times at all",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const record = await recordFor(emailFor(who));
    expect(record.publicBookingCount).toBe(0);
    expect(record.adminBookingCount).toBe(0);
  },
);

Then(
  "{word} is still counted as having booked {int} times and visited {int}",
  async function (
    this: TicketsWorld,
    who: string,
    booked: number,
    visits: number,
  ): Promise<void> {
    const record = await recordFor(emailFor(who));
    expect(record.publicBookingCount).toBe(booked);
    expect(record.visits).toBe(visits);
    expect(record.adminBookingCount).toBe(HAND_BOOKINGS);
  },
);
