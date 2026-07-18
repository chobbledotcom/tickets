import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ordinaryAttendeeCondition } from "#shared/db/attendees/ordinary.ts";

test("excludes staged attendees using the requested alias", () => {
  expect(ordinaryAttendeeCondition("bookingOwner")).toBe(
    "NOT EXISTS (SELECT 1 FROM checkout_stages AS checkoutStage WHERE checkoutStage.attendee_id = bookingOwner.id)",
  );
});
