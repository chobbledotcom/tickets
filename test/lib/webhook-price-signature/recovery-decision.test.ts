import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decideUnexpectedCreate } from "#routes/api/payment-processing/recovery-decision.ts";

test("recovers the attendee finalized for this ticket token", () => {
  expect(
    decideUnexpectedCreate({
      finalizedAttendeeId: 42,
      tokenAttendeeId: 42,
      unresolved: false,
    }),
  ).toEqual({ attendeeId: 42, kind: "recover" });
});

test("refunds an unresolved reservation with no committed attendee", () => {
  expect(
    decideUnexpectedCreate({
      finalizedAttendeeId: null,
      tokenAttendeeId: null,
      unresolved: true,
    }),
  ).toEqual({ kind: "refund" });
});

test("rethrows when another outcome already resolved the reservation", () => {
  expect(
    decideUnexpectedCreate({
      finalizedAttendeeId: null,
      tokenAttendeeId: null,
      unresolved: false,
    }),
  ).toEqual({ kind: "rethrow" });
});

test("rethrows an attendee beside an unresolved reservation", () => {
  expect(
    decideUnexpectedCreate({
      finalizedAttendeeId: null,
      tokenAttendeeId: 42,
      unresolved: true,
    }),
  ).toEqual({ kind: "rethrow" });
});
