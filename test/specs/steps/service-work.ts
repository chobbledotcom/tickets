// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  anyEventListedOn,
  dashboardCopy,
  eventsListedOn,
  holdPlaces,
  organiserOpensDashboard,
  organiserOpensServicing,
  rowFor,
  servicingCopy,
  waysIntoOn,
  workComingUpOn,
} from "#test/specs/support/service-work.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** A day in each year the stories name. Fixed rather than counted from today,
 * so a scenario run near midnight cannot set up against one day and read back
 * against the next. */
const DAY_IN = { "2000": "2000-07-01", "2099": "2099-07-01" } as const;

const dayIn = (year: string): string => {
  const day = DAY_IN[year as keyof typeof DAY_IN];
  if (!day) throw new Error(`No day is fixed for the year ${year}`);
  return day;
};

Given(
  "a {string} holds {int} places on Room A in {word}",
  function (
    this: TicketsWorld,
    name: string,
    places: number,
    year: string,
  ): Promise<void> {
    return holdPlaces(this, name, dayIn(year), [{ places, room: "Room A" }]);
  },
);

Given(
  "an {string} holds {int} places on Room A and {int} on Room B",
  function (
    this: TicketsWorld,
    name: string,
    onA: number,
    onB: number,
  ): Promise<void> {
    return holdPlaces(this, name, dayIn("2099"), [
      { places: onA, room: "Room A" },
      { places: onB, room: "Room B" },
    ]);
  },
);

/** Places held under one name in a given year, on a room of its own. Two
 * wordings over one body, because a story about work already done reads in
 * the past tense and one about work to come reads in the present. */
const holdsPlacesIn = function (
  this: TicketsWorld,
  name: string,
  year: string,
): Promise<void> {
  return holdPlaces(this, name, dayIn(year), [
    { places: 2, room: `Room for ${name}` },
  ]);
};

Given("a {string} held places in {word}", holdsPlacesIn);

Given("a {string} holds places in {word}", holdsPlacesIn);

When(
  "the organiser opens the Servicing page",
  function (this: TicketsWorld): Promise<void> {
    return organiserOpensServicing(this);
  },
);

When(
  "the organiser opens their dashboard",
  function (this: TicketsWorld): Promise<void> {
    return organiserOpensDashboard(this);
  },
);

Then(
  "the list names {string} holding {string}",
  function (this: TicketsWorld, name: string, rooms: string): void {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(name);
    expect(page).toContain(rooms);
  },
);

Then(
  "the list gives the day the work is due",
  function (this: TicketsWorld): void {
    // The day the story set the work for, written out here rather than asked
    // of the code that renders it, and read from that event's own row.
    const row = rowFor(
      this,
      whatTheyWereTold(this, ORGANISER),
      "Boiler Service",
    );
    expect(row).toContain("1 July 2099");
  },
);

Then(
  "the list says {int} places are held",
  function (this: TicketsWorld, places: number): void {
    // The Quantity cell itself, so a number that happened to appear in a date
    // or a listing name cannot answer for it.
    expect(whatTheyWereTold(this, ORGANISER)).toContain(`<td>${places}</td>`);
  },
);

/** How many ways into one service event the page offers. Curried on the
 * number, so "none" and "one" cannot drift into two readings of the page. */
const waysIn = (expected: number) =>
  function (this: TicketsWorld, name: string): void {
    expect(waysIntoOn(this, whatTheyWereTold(this, ORGANISER), name)).toBe(
      expected,
    );
  };

Then("there is one way into {string}", waysIn(1));

Then("there is no way into {string}", waysIn(0));

Then(
  "{string} is listed once",
  function (this: TicketsWorld, name: string): void {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(name);
    expect(eventsListedOn(page)).toBe(1);
  },
);

const workComingUp = (world: TicketsWorld): Promise<string> =>
  workComingUpOn(whatTheyWereTold(world, ORGANISER));

Then(
  "the work coming up names {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await workComingUp(this)).toContain(name);
  },
);

Then(
  "the work coming up does not name {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await workComingUp(this)).not.toContain(name);
  },
);

Then(
  "the work coming up names {string} over {int} listings",
  async function (
    this: TicketsWorld,
    name: string,
    listings: number,
  ): Promise<void> {
    const block = await workComingUp(this);
    expect(block).toContain(name);
    expect(block).toContain(
      await dashboardCopy("admin.dashboard.service_event_listing_count", {
        count: listings,
      }),
    );
  },
);

Then(
  "the page says there are no service events yet",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await servicingCopy("servicing.empty"),
    );
  },
);

Then("the page lists no service event", function (this: TicketsWorld): void {
  expect(anyEventListedOn(whatTheyWereTold(this, ORGANISER))).toBe(false);
});
