/** The pending-notification badges on the attendee rows: what the admin sees
 * when a send never got accepted. */

import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { assertJson, expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendeeWithFlags,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { adminGet, apiRequest } from "#test-utils/session.ts";

describeWithEnv("pending notification badges", { db: true }, () => {
  test("a red badge says the email never went out for an online booking", async () => {
    await bookTestAttendeeWithFlags("Flagged Buyer", 1, 0);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Flagged Buyer", "Email not sent", "badge danger"],
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

  test("a fields list beside email still owes the email badge", async () => {
    const { listing } = await bookTestAttendeeWithFlags(
      "Listed Fields Buyer",
      1,
      0,
    );
    // The stored form is trimmed tokens comma-joined, and the badge SQL
    // compares whole tokens, so "email" beside "phone" is still a collected
    // field.
    await execute("UPDATE listings SET fields = 'phone,email' WHERE id = ?", [
      listing.id,
    ]);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Listed Fields Buyer", "Email not sent"],
    });
  });

  test("a listing the admin API stored from a padded fields string owes the email badge", async () => {
    // The API write stores the parser's own read of the string, so a
    // space- or non-breaking-space-padded "email" stores "email" — and the
    // badge reads that stored token back. The direct booking leaves the
    // flags unset, so the test raises the email flag the way a send that
    // never got accepted would.
    const padded = [
      ["Api Space Buyer", " email "],
      ["Api Narrow Buyer", "\u00a0email\u00a0"],
    ] as const;
    for (const [name, fields] of padded) {
      const created = await assertJson<{ listing: { id: number } }>(
        apiRequest("/api/admin/listings", {
          body: { fields, max_attendees: 10, name },
          method: "POST",
        }),
        201,
      );
      const { attendee } = await createTestAttendeeDirect(
        created.listing.id,
        name,
        `${name.toLowerCase().replace(/\s+/g, "-")}@example.com`,
      );
      await execute("UPDATE attendees SET email_pending = 2 WHERE id = ?", [
        attendee.id,
      ]);
      await expectHtml(await adminGet("/admin/attendees"), {
        contains: [name, "Email not sent"],
      });
    }
  });

  test("a field name that merely contains email owes no email badge", async () => {
    const { listing } = await bookTestAttendeeWithFlags(
      "Lookalike Fields Buyer",
      1,
      0,
    );
    await execute("UPDATE listings SET fields = 'emailx' WHERE id = ?", [
      listing.id,
    ]);

    await expectHtml(await adminGet("/admin/attendees"), {
      contains: ["Lookalike Fields Buyer"],
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
