import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#shared/db/attendees/api.ts";

test("exposes the attendee database operations", () => {
  expect(Object.keys(attendeesApi).toSorted()).toEqual([
    "activateStagedAttendee",
    "applyAttendeeAtomicEdit",
    "checkBatchAvailability",
    "createAttendeeAtomic",
    "createBookingAtomic",
    "createStagedCheckoutAtomic",
    "hasAvailableSpots",
  ]);
});
