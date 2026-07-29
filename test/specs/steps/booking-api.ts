// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  type ApiAnswer,
  apiBooks,
  apiSaysThereIsRoom,
  daysTheApiOffers,
  openTheApi,
} from "#test/specs/support/booking-api.ts";
import { stayListing } from "#test/specs/support/listings.ts";
import { guest, newestStayOn, staysOn } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";

// jscpd:ignore-end

/** What the API last answered. */
const lastAnswer = (world: TicketsWorld): ApiAnswer =>
  requiredWorldValue(world.apiAnswer, "what the API answered");

/** The first day the API offers for a listing, remembered so the story's later
 * steps talk about the same day. */
const firstDayOffered = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  if (world.apiFirstDay === undefined) {
    const offered = await daysTheApiOffers(world, name);
    const first = offered[0];
    if (first === undefined) {
      throw new Error(`The API offers no day at all on the ${name}`);
    }
    world.apiFirstDay = first;
  }
  return world.apiFirstDay;
};

Given("the organiser opens the booking API", (): Promise<void> => openTheApi());

Given(
  "{int} {word} places are booked for one day, on the second day the API offers",
  async function (
    this: TicketsWorld,
    places: number,
    name: string,
  ): Promise<void> {
    const { addDays } = await import("#shared/dates.ts");
    const middle = addDays(await firstDayOffered(this, name), 1);
    // A one-day booking, so only the middle day of the coming stay is full.
    const booked = await bookAttendee(stayListing(this, name), {
      date: middle,
      durationDays: 1,
      quantity: places,
    });
    if (!booked.success) throw new Error(`Could not fill the ${name} middle`);
  },
);

When(
  "another system books the first {word} day the API offers",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const day = await firstDayOffered(this, name);
    this.stayStartsOn = day;
    this.apiAnswer = await apiBooks(this, name, day, guest(1).who);
    this.attendeeId = await newestStayOn(this, name);
  },
);

Then("the system is given a ticket", function (this: TicketsWorld): void {
  const { body, status } = lastAnswer(this);
  expect(status).toBe(200);
  // A ticket the customer can actually open, not merely a success code.
  const booking = body.booking as { ticketToken?: string } | undefined;
  expect(typeof booking?.ticketToken).toBe("string");
  expect(booking?.ticketToken).not.toBe("");
});

When(
  "another system asks about the first {word} day the API offers",
  async function (this: TicketsWorld, name: string): Promise<void> {
    this.apiRoomAnswer = await apiSaysThereIsRoom(
      this,
      name,
      await firstDayOffered(this, name),
    );
    this.apiListing = name;
  },
);

Then("the API says there is no room", function (this: TicketsWorld): void {
  expect(requiredWorldValue(this.apiRoomAnswer, "what the API said")).toBe(
    false,
  );
});

Then(
  "booking that day anyway is refused",
  async function (this: TicketsWorld): Promise<void> {
    const name = requiredWorldValue(this.apiListing, "the listing asked about");
    const answer = await apiBooks(
      this,
      name,
      await firstDayOffered(this, name),
      guest(2).who,
    );
    // 409 is the site's own "no room left" answer; any other code would mean
    // it was turned away for some unrelated reason.
    expect(answer.status).toBe(409);
  },
);

Then(
  "the {word} holds only the {int} stay it already had",
  async function (
    this: TicketsWorld,
    name: string,
    stays: number,
  ): Promise<void> {
    expect((await staysOn(this, name)).length).toBe(stays);
  },
);
