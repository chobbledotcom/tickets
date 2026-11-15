/** Shared fixtures for the group scanner's answer suites: the shape most answer
 *  edges start from, and the assertions each answer case repeats. */

import { expect } from "@std/expect";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import type { Attendee, Group, ListingWithCount } from "#types";

/** One answer from the group scan route: the HTTP response and its JSON body. */
export type DoorAnswer = {
  json: {
    error?: unknown;
    name?: unknown;
    quantity?: unknown;
    remaining?: unknown;
    status?: unknown;
  };
  response: Response;
};

/** One one-listing door and the attendee booked on its only listing. */
export type BookedDoor = { attendee: Attendee; door: Door };

/** A group door with its member listings. */
export type Door = { group: Group; members: ListingWithCount[] };

/** One one-listing door with one attendee booked on that listing. */
export const doorWithAttendee = async (
  name: string,
  email: string,
): Promise<BookedDoor> => {
  const door = await groupDoor(1);
  const attendee = await bookTestAttendee([door.members[0]!.id], name, email);
  return { attendee, door };
};

/** A stranger: `name` booked on another door's only listing, beside a door of
 *  its own. Names are unique across the whole site — listings and groups both. */
export const strangerAtAnotherDoor = async (name: string, email: string) => {
  const otherDoor = await groupDoor(1, {}, ["Stranger hall"], "Other doors");
  const stranger = await bookTestAttendee(
    [otherDoor.members[0]!.id],
    name,
    email,
  );
  return { door: await groupDoor(1), otherDoor, stranger };
};

/** The door's answer to the request `body` builds from the attendee booked on
 *  the door's only listing. */
export const bookedScanAnswer = async (
  name: string,
  email: string,
  body: (booked: {
    attendee: Awaited<ReturnType<typeof bookTestAttendee>>;
    door: Awaited<ReturnType<typeof groupDoor>>;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>,
) => {
  const booked = await doorWithAttendee(name, email);
  const answer = await scanAtDoor(booked.door.group.id, await body(booked));
  return { ...booked, answer };
};

/** Assert the door answered `http` and named `body`: a status word, or a
 *  refusal object such as `{ error: "Missing token" }`. */
export const expectScanAnswer = (
  answer: DoorAnswer,
  http: number,
  body: string | { readonly error: string },
): void => {
  expect(answer.response.status).toBe(http);
  expect(answer.json).toMatchObject(
    typeof body === "string" ? { status: body } : body,
  );
};

/** Assert the door gave `status` and named `name` as the person the ticket
 *  belongs to. */
export const expectNamedAnswer = (
  answer: DoorAnswer,
  status: string,
  name: string,
): void => {
  expectScanAnswer(answer, 200, status);
  expect(answer.json.name).toBe(name);
};

/** Assert the door admitted the ticket and named the person it belongs to. */
export const expectAdmitted = (answer: DoorAnswer, name: string): void =>
  expectNamedAnswer(answer, "checked_in", name);

/** Assert the door admitted `quantity` places of the line and left `remaining`
 *  places still to admit. */
export const expectPlacesTaken = (
  answer: DoorAnswer,
  quantity: number,
  remaining: number,
): void => {
  expect(answer.json.quantity).toBe(quantity);
  expect(answer.json.remaining).toBe(remaining);
};

/** The attendee's one booking row must hold exactly `checkedIn` — a second
 *  row or another count fails the case. */
export const expectCheckinRow = async (
  attendeeId: number,
  checkedIn: number,
): Promise<void> => {
  expect(await storedCheckinRows(attendeeId)).toEqual([
    { checked_in: checkedIn },
  ]);
};
