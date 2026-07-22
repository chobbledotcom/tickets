import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeTables } from "#shared/db/migrations/schema/tables-attendees.ts";

test("the attendee tables include checkout stages", () => {
  expect(attendeeTables.map(([name]) => name)).toContain("checkout_stages");
});
