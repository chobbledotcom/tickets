/** The create fixture fails at the seed when the write is refused, so a test
 *  never asserts against a row that did not land. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createAttendeeOrThrow } from "#test-utils/db-helpers/attendee-atomic-create.ts";

describeWithEnv("test helper > createAttendeeOrThrow", { db: true }, () => {
  test("throws with the refusal reason when the write is refused", async () => {
    await expect(
      createAttendeeOrThrow({
        bookings: [],
        email: "refused@example.com",
        name: "Refused",
      }),
    ).rejects.toThrow("create refused");
  });
});
