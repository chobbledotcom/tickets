/** The dashboard's count of bookings still owed a notification send: shown
 * when it is above zero, linking to the attendees browser. */

import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "the dashboard's unsent notification count",
  { db: true },
  () => {
    test("counts the attendees with unsent notifications", async () => {
      await bookTestAttendeeWithFlags("Counted Buyer", 1, 0);
      await bookTestAttendeeWithFlags("Second Counted Buyer", 0, 1);
      await bookTestAttendeeWithFlags("Clean Buyer", 0, 0);

      await expectHtml(await adminGet("/admin"), {
        contains: [
          "2 attendees have emails or webhooks that were not sent",
          'href="/admin/attendees"',
        ],
      });
    });

    test("hides the count when every send got through", async () => {
      await bookTestAttendeeWithFlags("Only Clean Buyer", 0, 0);

      await expectHtml(await adminGet("/admin"), {
        notContains: ["emails or webhooks that were not sent"],
      });
    });

    test("does not count an email flag whose listing stopped collecting email", async () => {
      const { listing } = await bookTestAttendeeWithFlags(
        "Stale Email Count",
        1,
        0,
      );
      await execute("UPDATE listings SET fields = 'phone' WHERE id = ?", [
        listing.id,
      ]);

      await expectHtml(await adminGet("/admin"), {
        notContains: ["emails or webhooks that were not sent"],
      });
    });

    test("counts a booking whose stored fields carry padding around email", async () => {
      const { listing } = await bookTestAttendeeWithFlags(
        "Padded Count Buyer",
        1,
        0,
      );
      await execute("UPDATE listings SET fields = ' email ' WHERE id = ?", [
        listing.id,
      ]);

      await expectHtml(await adminGet("/admin"), {
        contains: ["1 attendee has emails or webhooks that were not sent"],
      });
    });
  },
);
