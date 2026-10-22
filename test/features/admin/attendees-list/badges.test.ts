/** The pending-notification badges on the attendee rows: what the admin sees
 * when a send never got accepted. */

import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("pending notification badges", { db: true }, () => {
  test("a red badge says the email never went out for an online booking", async () => {
    await bookTestAttendeeWithFlags("Flagged Buyer", 1, 0);

    // The whole rendered cell: the space text node between the name and the
    // pill is the fix for the glued "Flagged BuyerEmail not sent" read.
    await expectHtml(await adminGet("/admin/attendees"), {
      contains: [
        'Flagged Buyer</a> <span class="badge danger">Email not sent</span>',
      ],
      notContains: ["Webhooks not sent"],
    });
  });

  test("an orange badge marks a hand-added attendee's owed email", async () => {
    await bookTestAttendeeWithFlags("Hand Added Buyer", 2, 0);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Hand Added Buyer", "Email not sent", "badge-warning"],
    });
  });

  test("a booking whose listing stopped collecting email carries no email badge", async () => {
    const { listing } = await bookTestAttendeeWithFlags(
      "Dropped Email Buyer",
      1,
      0,
    );
    // The listing no longer collects an email, so the stored flag no longer
    // means an owed send: the badge follows the current rule, not the flag
    // alone.
    await execute("UPDATE listings SET fields = 'phone' WHERE id = ?", [
      listing.id,
    ]);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Dropped Email Buyer"],
      notContains: ["Email not sent"],
    });
  });

  test("a booking whose webhooks never went out says so", async () => {
    await bookTestAttendeeWithFlags("Webhook Buyer", 0, 1);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Webhook Buyer", "Webhooks not sent"],
      notContains: ["Email not sent"],
    });
  });

  test("a booking whose sends were accepted carries no badge", async () => {
    await bookTestAttendeeWithFlags("Notified Buyer", 0, 0);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Notified Buyer"],
      notContains: ["Email not sent", "Webhooks not sent"],
    });
  });
});

describeWithEnv(
  "pending notification badges on the attendee page",
  { db: true },
  () => {
    test("a red badge sits beside the name on the attendee's own page", async () => {
      const { attendee } = await bookTestAttendeeWithFlags("Page Buyer", 1, 0);

      await expectHtml(await adminGet(`/admin/attendees/${attendee.id}`), {
        contains: ["Page Buyer", "Email not sent", "badge danger"],
        notContains: ["Webhooks not sent"],
      });
    });

    test("an orange badge marks a hand-added attendee on their page", async () => {
      const { attendee } = await bookTestAttendeeWithFlags(
        "Page Hand Added",
        2,
        0,
      );

      await expectHtml(await adminGet(`/admin/attendees/${attendee.id}`), {
        contains: ["Page Hand Added", "Email not sent", "badge-warning"],
      });
    });

    test("a page for a notified booking carries no badge", async () => {
      const { attendee } = await bookTestAttendeeWithFlags(
        "Page Notified",
        0,
        0,
      );

      await expectHtml(await adminGet(`/admin/attendees/${attendee.id}`), {
        contains: ["Page Notified"],
        notContains: ["Email not sent", "Webhooks not sent"],
      });
    });
  },
);
