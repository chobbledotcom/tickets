/**
 * Booking through the site's own booking API — the way another system books on
 * a customer's behalf. The booking API needs no key, so every call here is made
 * without one: a story must fail if the endpoints ever start demanding
 * authorisation, because real callers would stop working that day.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { emailFor } from "#test/specs/support/emails.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import type {
  ReadAboutOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import { mockRequest } from "#test-utils/mocks.ts";
// jscpd:ignore-end

/** What the API answered: the code it sent back, and the body it sent with it. */
export interface ApiAnswer {
  body: Record<string, unknown>;
  status: number;
}

const ask = async (
  path: string,
  options: { body?: Record<string, unknown>; method?: string } = {},
): Promise<ApiAnswer> => {
  const method = options.method ?? "GET";
  const response = await handleRequest(
    mockRequest(path, {
      ...(options.body === undefined
        ? {}
        : {
            body: JSON.stringify(options.body),
            headers: { "content-type": "application/json" },
          }),
      method,
    }),
  );
  return { body: await response.json(), status: response.status };
};

/** Read one of the booking API's listing endpoints, and fail the story when
 * the site does not answer with a 200 — a reader that carried on with a
 * refusal body would report on an answer nobody got. */
const askListingsApi = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const { body, status } = await ask(path);
  expect(status).toBe(200);
  return body;
};

/** What the availability reader asks about, named as one type so the API
 * helpers that share the shape do not each spell it out. */
type ReadsAvailability<Answer> = (
  world: TicketsWorld,
  name: string,
  day: string,
) => Promise<Answer>;

/** The organiser opens the booking API up to other systems. */
export const openTheApi = (): Promise<void> =>
  settings.update.showPublicApi(true);

/** The days the API says a listing can be booked from. */
export const daysTheApiOffers: ReadAboutOneThing<string[]> = async (
  world,
  name,
) => {
  const body = await askListingsApi(
    `/api/listings/${listingNamed(world, name).slug}`,
  );
  const { availableDates } = (body.listing ?? {}) as Record<string, unknown>;
  // Every day has to be a day. A list carrying anything else is a broken
  // promise to the systems that read it, even when the first day is fine.
  if (
    !Array.isArray(availableDates) ||
    availableDates.some((day) => typeof day !== "string")
  ) {
    throw new Error(`The API did not list the days the ${name} offers`);
  }
  return availableDates;
};

/** Whether the API says a stay starting on this day can still be booked. */
export const apiSaysThereIsRoom: ReadsAvailability<boolean> = async (
  world,
  name,
  day,
) => {
  const slug = listingNamed(world, name).slug;
  const body = await askListingsApi(
    `/api/listings/${slug}/availability?date=${day}&quantity=1`,
  );
  // The answer has to be the yes-or-no the API documents. A missing or renamed
  // field would otherwise read as "no room" and pass a refusal story silently.
  const { available } = body;
  if (typeof available !== "boolean") {
    throw new Error(`The API did not say whether there is room: ${available}`);
  }
  return available;
};

/** Book a stay through the API, keeping whatever it answered — a story can
 * then prove either the booking or the refusal. */
export const apiBooks = async (
  world: TicketsWorld,
  name: string,
  day: string,
  who: string,
): Promise<ApiAnswer> =>
  ask(`/api/listings/${listingNamed(world, name).slug}/book`, {
    body: {
      date: day,
      email: emailFor(who),
      name: who,
      // The API requires the field: a machine caller names its count, and the
      // API never defaults one. Every journey here books one place a day.
      quantity: 1,
    },
    method: "POST",
  });
