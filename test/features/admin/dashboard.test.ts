import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loginResponse } from "#routes/admin/dashboard.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  adminGet,
  createTestAgentSession,
  createTestEditorSession,
  getTestSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";
import { withSetting } from "#test-utils/settings.ts";

describeWithEnv("admin listings route", { db: true }, () => {
  test("narrows the listings page to the chosen group's members", async () => {
    const { group } = await createGroupWithListings("Autumn fair", [
      "Fair Listing",
    ]);
    await createTestListing({ name: "Outside Listing" });
    const html = await (
      await adminGet(`/admin/listings?group=${group.id}`)
    ).text();
    assertStringIncludes(html, "Fair Listing");
    assert(!html.includes("Outside Listing"));
    assertStringIncludes(
      html,
      'Group: <a href="/admin/listings">All groups</a> / <strong><u>Autumn fair</u></strong>',
    );
  });

  test("falls back to every listing for an unknown group", async () => {
    await createGroupWithListings("Autumn fair", ["Fair Listing"]);
    await createTestListing({ name: "Outside Listing" });
    const html = await (await adminGet("/admin/listings?group=999999")).text();
    assertStringIncludes(html, "Fair Listing");
    assertStringIncludes(html, "Outside Listing");
    assertStringIncludes(html, "Group: <strong><u>All groups</u></strong>");
  });

  test("editor listings ignore an invalid owner column layout", async () => {
    const { cookie } = await createTestEditorSession();
    const response = await withSetting(
      { listing_column_order: "{{unknown}}" },
      () => awaitTestRequest("/admin/listings", { cookie }),
    );
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), "Listings");
  });

  test("owner listings use the saved column layout", async () => {
    const { cookie } = await getTestSession();
    const html = await withSetting(
      { listing_column_order: "{{name}}" },
      async () =>
        (await awaitTestRequest("/admin/listings", { cookie })).text(),
    );
    assertStringIncludes(html, "<th>Listing name</th>");
    assert(!html.includes("<th>Status</th>"));
  });

  test("dashboard redirects non-dashboard roles to their own landing pages", async () => {
    const { cookie: agentCookie } = await createTestAgentSession();
    const { cookie: editorCookie } = await createTestEditorSession();
    const { cookie: scannerCookie } = await createTestScannerSession();
    expect(
      (await awaitTestRequest("/admin/", { cookie: agentCookie })).headers.get(
        "location",
      ),
    ).toBe("/admin/deliveries");
    expect(
      (await awaitTestRequest("/admin/", { cookie: editorCookie })).headers.get(
        "location",
      ),
    ).toBe("/admin/listings");
    expect(
      (
        await awaitTestRequest("/admin/", { cookie: scannerCookie })
      ).headers.get("location"),
    ).toBe("/admin/scanner");
  });

  test("dashboard shows only the ten newest attendees", async () => {
    const { cookie, listing } = await setupListingAndLogin();
    for (let index = 0; index < 11; index++) {
      await createTestAttendee(
        listing.id,
        listing.slug,
        `Guest ${index}`,
        `guest-${index}@example.com`,
      );
    }
    const html = await (await awaitTestRequest("/admin/", { cookie })).text();
    expect(html.match(/Guest \d+/g)).toHaveLength(10);
  });
});

describe("loginResponse", () => {
  test("uses status 200 by default", async () => {
    expect(
      (await loginResponse(new Request("http://localhost/admin/"))).status,
    ).toBe(200);
  });

  test("uses the supplied status", async () => {
    expect(
      (await loginResponse(new Request("http://localhost/admin/"), 418)).status,
    ).toBe(418);
  });
});
