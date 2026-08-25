/**
 * The moment a listing stops taking bookings, set the way the organiser sets
 * it — through the listing's own edit form — and read back the way a customer
 * meets it: on the page, in an order, and at the moment of sending.
 */

// jscpd:ignore-start
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import { organiserSavesListing } from "#test/specs/support/listings.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Noon on a day counted from the Scenario's own first day, split the way
 * the edit form asks for it — a date box and a time box. Noon yesterday is
 * safely in the past and noon tomorrow safely in the future, wherever the
 * Scenario runs. */
const noonOn = (
  world: TicketsWorld,
  daysFromToday: number,
): { closes_at_date: string; closes_at_time: string } => ({
  closes_at_date: dayFromToday(world, daysFromToday),
  closes_at_time: "12:00",
});

/** The organiser sets the moment this listing stops taking bookings, through
 * its own edit form. The boxes have to really carry the moment: a form that
 * stopped offering them is a form nobody could close anything with. */
export const closesOn = async (
  world: TicketsWorld,
  name: string,
  daysFromToday: number,
): Promise<void> => {
  const closingTime = noonOn(world, daysFromToday);
  await organiserSavesListing(world, name, (served) => {
    expectCanReallySend(served, closingTime);
    return closingTime;
  });
};
