/**
 * Booking through the site's own booking API — the way another system books on
 * a customer's behalf. Every call goes through the real endpoints with a real
 * key, so a story proves what an outside caller can actually do.
 */

import { expect } from "@std/expect";
import { settings } from "#shared/db/settings.ts";
import { stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { apiRequest } from "#test-utils/session.ts";

/** What the API answered: the code it sent back, and the body it sent with it. */
export interface ApiAnswer {
  body: Record<string, unknown>;
  status: number;
}

const ask = async (
  path: string,
  options: { body?: Record<string, unknown>; method?: string } = {},
): Promise<ApiAnswer> => {
  const response = await apiRequest(path, options);
  return { body: await response.json(), status: response.status };
};

/** The organiser opens the booking API up to other systems. */
export const openTheApi = (): Promise<void> =>
  settings.update.showPublicApi(true);

/** The days the API says a listing can be booked from. */
export const daysTheApiOffers = async (
  world: TicketsWorld,
  name: string,
): Promise<string[]> => {
  const { body, status } = await ask(
    `/api/listings/${stayListing(world, name).slug}`,
  );
  expect(status).toBe(200);
  const listing = body.listing as { availableDates?: string[] } | undefined;
  if (!listing?.availableDates) {
    throw new Error(`The API told us nothing about the ${name}`);
  }
  return listing.availableDates;
};

/** Whether the API says a stay starting on this day can still be booked. */
export const apiSaysThereIsRoom = async (
  world: TicketsWorld,
  name: string,
  day: string,
): Promise<boolean> => {
  const slug = stayListing(world, name).slug;
  const { body, status } = await ask(
    `/api/listings/${slug}/availability?date=${day}&quantity=1`,
  );
  expect(status).toBe(200);
  return body.available === true;
};

/** Book a stay through the API, keeping whatever it answered — a story can
 * then prove either the booking or the refusal. */
export const apiBooks = async (
  world: TicketsWorld,
  name: string,
  day: string,
  who: string,
): Promise<ApiAnswer> =>
  ask(`/api/listings/${stayListing(world, name).slug}/book`, {
    body: {
      date: day,
      email: `${who.toLowerCase().replaceAll(" ", ".")}@example.com`,
      name: who,
    },
    method: "POST",
  });
