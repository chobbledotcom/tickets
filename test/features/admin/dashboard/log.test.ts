import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { logActivity } from "#test-utils/activity-log.ts";
import {
  assertAdminHtmlWithCookie,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";

describeWithEnv("admin activity log", { db: true }, () => {
  testRequiresAuth("/admin/log");

  test("shows log page when authenticated", async () => {
    await createTestListing({ maxAttendees: 50, name: "Log Test" });
    await expectHtmlResponse(await adminGet("/admin/log"), 200, "Log");
  });

  test("shows log page for manager", async () => {
    const managerCookie = await createTestManagerSession();
    await assertAdminHtmlWithCookie("/admin/log", managerCookie, "Log");
  });

  test("shows only the most recent 200 entries", async () => {
    for (let index = 0; index < 201; index++) {
      await logActivity(`Action ${index}`);
    }
    const html = await (await adminGet("/admin/log")).text();
    expect(html).toContain("Showing the most recent 200 entries");
    expect(html).toContain("Action 200");
    expect(html).toContain("Action 1");
    expect(html).not.toContain("Action 0</td>");
  });

  test("does not mark exactly 200 entries as truncated", async () => {
    for (let index = 0; index < 200; index++) {
      await logActivity(`Exact action ${index}`);
    }
    const html = await (await adminGet("/admin/log")).text();
    expect(html).not.toContain("Showing the most recent 200 entries");
  });

  test("links each entry to its attendee and listing by name", async () => {
    const { listing, cookie } = await setupListingAndLogin({
      maxAttendees: 50,
      name: "Gala Dinner",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Ada Lovelace",
      "ada@example.com",
    );
    await logActivity("Balance updated", listing.id, attendee.id);

    const html = await (
      await awaitTestRequest("/admin/log", { cookie })
    ).text();
    expect(html).toContain(
      `<a href="/admin/attendees/${attendee.id}">Ada Lovelace</a>`,
    );
    expect(html).toContain(
      `<a href="/admin/listing/${listing.id}">Gala Dinner</a>`,
    );
  });
});
