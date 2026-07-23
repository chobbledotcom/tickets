import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeTables } from "#shared/db/migrations/schema/tables-attendees.ts";

test("the attendee tables include checkout and refund recovery", () => {
  expect(attendeeTables.map(([name]) => name)).toEqual(
    expect.arrayContaining(["checkout_stages", "payment_refund_attempts"]),
  );
});
