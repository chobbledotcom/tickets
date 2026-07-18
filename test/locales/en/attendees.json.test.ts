import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import attendees from "#locales/en/attendees.json" with { type: "json" };

test("loads the attendee message catalog", () => {
  expect(attendees["admin.attendees.refund_all_label"]).toBe("Listing name");
});
