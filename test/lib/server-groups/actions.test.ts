import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { validateGroupListingType } from "#shared/db/groups.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  assertAdminHtml,
  awaitTestRequest,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectStatus,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  updateTestGroup,
} from "#test-utils";

describeWithEnv(
  "server (admin groups) — actions & validation",
  { db: true },
  () => {
    beforeEach(() => {
      setDemoModeForTest(false);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    describe("redirect after create/edit", () => {
      test("create redirects to group detail page", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/groups",
            {
              csrf_token: csrfToken,
              name: "Redirect Test",
              terms_and_conditions: "",
            },
            cookie,
          ),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toMatch(/\/admin\/groups\/\d+(\?|$)/);
        expectFlash(response, "Group created");
      });

      test("edit redirects to group detail page", async () => {
        const group = await createTestGroup({
          name: "Edit Redir",
          slug: "edit-redir",
        });
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/edit`,
            {
              csrf_token: csrfToken,
              name: "Edited Redir",
              slug: "edited-redir",
              terms_and_conditions: "",
            },
            cookie,
          ),
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/groups/${group.id}`,
          "Group updated",
        )(response);
      });
    });

    describe("group max_attendees", () => {
      test("creates group with max_attendees", async () => {
        const group = await createTestGroup({
          maxAttendees: 50,
          name: "Capped",
          slug: "capped",
        });
        expect(group.max_attendees).toBe(50);
      });

      test("creates group without max_attendees defaults to 0", async () => {
        const group = await createTestGroup({
          name: "Uncapped",
          slug: "uncapped",
        });
        expect(group.max_attendees).toBe(0);
      });

      test("edit form shows max_attendees field", async () => {
        const group = await createTestGroup({
          maxAttendees: 25,
          name: "Edit Max",
          slug: "edit-max",
        });

        await assertAdminHtml(
          `/admin/groups/${group.id}/edit`,
          "max_attendees",
          "25",
        );
      });

      test("updates max_attendees via edit", async () => {
        const group = await createTestGroup({
          maxAttendees: 10,
          name: "Update Max",
          slug: "update-max",
        });

        const updated = await updateTestGroup(group.id, { maxAttendees: 30 });
        expect(updated.max_attendees).toBe(30);
      });

      test("detail page shows Group Attendees with cap when set", async () => {
        const group = await createTestGroup({
          maxAttendees: 100,
          name: "Detail Max",
          slug: "detail-max",
        });

        await assertAdminHtml(
          `/admin/groups/${group.id}`,
          "Group Attendees",
          "0 / 100",
        );
      });

      test("detail page shows Group Attendees with no-cap note when uncapped", async () => {
        const group = await createTestGroup({
          name: "Detail No Max",
          slug: "detail-no-max",
        });

        await assertAdminHtml(
          `/admin/groups/${group.id}`,
          "Group Attendees",
          "(no group cap)",
        );
      });
    });

    describe("validateGroupListingType - customisable days", () => {
      test("rejects a non-customisable listing joining a customisable group", async () => {
        const group = await createTestGroup({ name: "Cust Group" });
        await createTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000 },
          durationDays: 1,
          groupId: group.id,
          name: "Customisable Member",
        });
        const error = await validateGroupListingType(
          group.id,
          "standard",
          false,
        );
        expect(error).toBe(
          "This group already contains listings with customisable days — all listings in a group must match",
        );
      });

      test("rejects a customisable listing joining a non-customisable group", async () => {
        const group = await createTestGroup({ name: "Plain Group" });
        await createTestListing({
          groupId: group.id,
          name: "Plain Member",
        });
        const error = await validateGroupListingType(
          group.id,
          "standard",
          true,
        );
        expect(error).toBe(
          "This group already contains listings without customisable days — all listings in a group must match",
        );
      });

      test("accepts a listing whose customisable setting matches the group", async () => {
        const group = await createTestGroup({ name: "Match Group" });
        await createTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000 },
          durationDays: 1,
          groupId: group.id,
          name: "Match Member",
        });
        const error = await validateGroupListingType(
          group.id,
          "standard",
          true,
        );
        expect(error).toBeNull();
      });
    });

    describe("nav link", () => {
      test("groups link visible to owners", async () => {
        await assertAdminHtml("/admin/groups", "/admin/groups", "Groups");
      });

      test("groups link visible to managers", async () => {
        const response = await awaitTestRequest("/admin/", {
          cookie: await createTestManagerSession("mgr-groups-nav"),
        });
        expectStatus(200)(response);
        const html = await response.text();
        expect(html).toContain("/admin/groups");
      });
    });
  },
);
