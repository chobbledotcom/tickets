import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SCHEMA_HASH } from "#shared/db/migrations/schema/index.ts";
import { attendeeTables } from "#shared/db/migrations/schema/tables-attendees.ts";

test("the attendee table definitions match the named migration snapshot", () => {
  expect(attendeeTables.map(([name]) => name)).toContain("checkout_stages");
  expect(SCHEMA_HASH).toBe("4uqaw8");
});
