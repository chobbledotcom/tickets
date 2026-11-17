/**
 * The four attendee paths that carry no record id, asked as themselves.
 *
 * Each is bound by its own key in the area's route table. A key that stopped
 * naming its path would leave the page unreachable, which is what these ask.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("the attendee pages every listing shares", { db: true }, () => {
  for (const [name, path] of [
    ["serves the attendee list", "/admin/attendees"],
    [
      "serves the form for adding one without a listing in hand",
      "/admin/attendees/new",
    ],
  ] as const) {
    test(name, async () => {
      expectStatus(200)(await adminGet(path));
    });
  }

  test("serves the list as a spreadsheet", async () => {
    const response = expectStatus(200)(await adminGet("/admin/attendees/csv"));

    assertStringIncludes(
      response.headers.get("content-type") ?? "",
      "text/csv",
    );
  });

  test("takes that form back", async () => {
    // Nothing is filled in, so the form comes straight back with the reason on
    // it, rather than the submission going through.
    const { response } = await adminFormPost("/admin/attendees/new", {});

    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), "required");
  });

  test("renders the date error when a malformed startDate rides a daily booking", async () => {
    // A daily listing is booked, so the shared start date is required. The
    // submitted "not-a-date" must answer the form page with the validation
    // error, not throw while the rejected values re-render.
    const listing = await createDailyTestListing();
    const { response } = await adminFormPost("/admin/attendees/new", {
      email: "a@test.com",
      lineListing0: String(listing.id),
      name: "A",
      qty0: "1",
      startDate: "not-a-date",
    });

    expect(response.status).toBe(200);
    assertStringIncludes(
      await response.text(),
      "A start date is required for the booked daily listings",
    );
  });
});
