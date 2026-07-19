import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loginResponse } from "#routes/admin/dashboard.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  getTestSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";
import { withSetting } from "#test-utils/settings.ts";

describeWithEnv("admin listings route", { db: true }, () => {
  test("editor listings ignore an invalid owner column layout", async () => {
    const { cookie } = await createTestEditorSession();
    const response = await withSetting(
      { listing_column_order: "{{unknown}}" },
      () => awaitTestRequest("/admin/listings", { cookie }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Listings");
  });

  test("owner listings use the saved column layout", async () => {
    const { cookie } = await getTestSession();
    const html = await withSetting(
      { listing_column_order: "{{name}}" },
      async () =>
        (await awaitTestRequest("/admin/listings", { cookie })).text(),
    );
    expect(html).toContain("<th>Listing Name</th>");
    expect(html).not.toContain("<th>Status</th>");
  });

  test("dashboard redirects non-dashboard roles to their own landing pages", async () => {
    const { cookie: agentCookie } = await createTestAgentSession();
    const { cookie: editorCookie } = await createTestEditorSession();
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
