/** The dashboard's count of bookings still owed a notification send: shown
 * when it is above zero, linking to the attendees browser. */

import { it as test } from "@std/testing/bdd";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "the dashboard's unsent notification count",
  { db: true },
  () => {
    test("counts the bookings with unsent notifications", async () => {
      await bookTestAttendeeWithFlags("Counted Buyer", 1, 0);
      await bookTestAttendeeWithFlags("Second Counted Buyer", 0, 1);
      await bookTestAttendeeWithFlags("Clean Buyer", 0, 0);

      await expectHtml(await adminGet("/admin"), {
        contains: [
          "2 bookings have unsent notifications",
          'href="/admin/attendees"',
        ],
      });
    });

    test("hides the count when every send got through", async () => {
      await bookTestAttendeeWithFlags("Only Clean Buyer", 0, 0);

      await expectHtml(await adminGet("/admin"), {
        notContains: ["unsent notifications"],
      });
    });
  },
);
