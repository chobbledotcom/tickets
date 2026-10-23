import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlashRedirect,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";
import {
  adminFormPost,
  adminGet,
  createTestEditorSession,
  createTestManagerSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv(
  "server (admin groups) — tabs & add-listings",
  { db: true },
  () => {
    beforeEach(() => {
      setDemoModeForTest(false);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    describe("group entity page tabs", () => {
      test("renders a tab strip linking Overview, Attendees, Edit, and Actions", async () => {
        const group = await createTestGroup({ name: "Tabbed", slug: "tabbed" });
        const html = await (await adminGet(`/admin/groups/${group.id}`)).text();
        assertStringIncludes(html, `href="/admin/groups/${group.id}"`);
        assertStringIncludes(
          html,
          `href="/admin/groups/${group.id}/attendees"`,
        );
        assertStringIncludes(html, `href="/admin/groups/${group.id}/edit"`);
        assertStringIncludes(html, `href="/admin/groups/${group.id}/actions"`);
        // The admin nav highlights the Groups section (navActive).
        assertStringIncludes(html, 'class="active" href="/admin/groups"');
      });

      test("Actions tab shows the export, bulk-actions, and delete links", async () => {
        const group = await createTestGroup({
          name: "Actions Group",
          slug: "actions-group",
        });
        const html = await (
          await adminGet(`/admin/groups/${group.id}/actions`)
        ).text();
        assertStringIncludes(html, `/admin/groups/${group.id}/export.json`);
        assertStringIncludes(html, `/admin/groups/${group.id}/bulk-actions`);
        assertStringIncludes(html, `/admin/groups/${group.id}/delete`);
        // Each action carries its icon (an empty icon name drops the <use> ref);
        // the nav renders none of these, so the refs are unique to the buttons.
        assertStringIncludes(html, "#save");
        assertStringIncludes(html, "#hammer");
        assertStringIncludes(html, "#trash-2");
        // Delete is destructive, so it renders inside the danger zone (danger: true).
        assertStringIncludes(html, "entity-danger-zone");
      });

      test("returns 404 for an unknown tab", async () => {
        const group = await createTestGroup({
          name: "Unknown Tab",
          slug: "unknown-tab",
        });
        const response = await adminGet(`/admin/groups/${group.id}/nope`);
        expectStatus(404)(response);
      });

      test("an editor's group page resolves to the staff-free Edit tab", async () => {
        // Editors never saw the staff-only detail page; every tab but Edit is
        // staff-gated, so a bare group URL lands them on the Edit form and hides
        // the Overview's share affordances.
        const group = await createTestGroup({
          name: "Editor Group",
          slug: "editor-group",
        });
        const response = await awaitTestRequest(`/admin/groups/${group.id}`, {
          cookie: (
            await createTestEditorSession({ username: "editor-group-page" })
          ).cookie,
        });
        expectStatus(200)(response);
        const html = await response.text();
        assertStringIncludes(html, `action="/admin/groups/${group.id}/edit"`);
        assert(!html.includes("Public URL"));
      });
    });

    describe("POST /admin/groups/:id/add-listings", () => {
      testRequiresAuth("/admin/groups/1/add-listings", {
        body: { listing_ids: "1" },
        method: "POST",
      });

      test("accessible to managers", async () => {
        const group = await createTestGroup({
          name: "Add Allow",
          slug: "add-allow",
        });
        const cookie = await createTestManagerSession("mgr-add-listings");
        const csrfToken = await signCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/add-listings`,
            {
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expect(response.status).toBe(302);
      });

      test("returns 404 for non-existent group", async () => {
        const { response } = await adminFormPost(
          "/admin/groups/999/add-listings",
          {
            listing_ids: "1",
          },
        );
        expectStatus(404)(response);
      });

      test("assigns ungrouped listings to group", async () => {
        const group = await createTestGroup({
          name: "Assign Group",
          slug: "assign-group",
        });
        const listing1 = await createTestListing({ name: "Listing A" });
        const listing2 = await createTestListing({ name: "Listing B" });

        expect(await listingGroups.getIds(listing1.id)).toEqual([]);
        expect(await listingGroups.getIds(listing2.id)).toEqual([]);

        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/add-listings`,
            {
              csrf_token: csrfToken,
              listing_ids: String(listing1.id),
            },
            cookie,
          ),
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/groups/${group.id}`,
          "Listings added to group",
        )(response);

        assertArrayIncludes(await listingGroups.getIds(listing1.id), [
          group.id,
        ]);
        expect(await listingGroups.getIds(listing2.id)).toEqual([]);
        // The assignment is recorded in the activity log.
        const { getAllActivityLog } = await import(
          "#test-utils/activity-log.ts"
        );
        const log = await getAllActivityLog();
        expect(
          log.some((e) => e.message.includes("added to group 'Assign Group'")),
        ).toBe(true);
      });

      test("rejects every listing when another selection was deleted", async () => {
        const group = await createTestGroup({
          name: "Stale selection group",
          slug: "stale-selection-group",
        });
        const listing = await createTestListing({ name: "Existing selection" });
        const body = new URLSearchParams({ csrf_token: await testCsrfToken() });
        body.append("listing_ids", String(listing.id));
        body.append("listing_ids", "999999");
        const response = await handleRequest(
          mockRequest(`/admin/groups/${group.id}/add-listings`, {
            body,
            headers: { cookie: await testCookie() },
            method: "POST",
          }),
        );

        await expectFlashRedirect(
          `/admin/groups/${group.id}`,
          t("error.selected_listing_deleted"),
          false,
        )(response);
        expect(await listingGroups.getIds(listing.id)).toEqual([]);
      });

      test("redirects to the group list when the group vanishes before the write", async () => {
        const group = await createTestGroup({
          name: "Vanishing group",
          slug: "vanishing-group",
        });
        const listing = await createTestListing({ name: "Waiting listing" });
        const restore = beforeNextTransaction(async () => {
          await execute("DELETE FROM groups WHERE id = ?", [group.id]);
        });

        let response: Response;
        try {
          ({ response } = await adminFormPost(
            `/admin/groups/${group.id}/add-listings`,
            { listing_ids: String(listing.id) },
          ));
        } finally {
          restore();
        }

        await expectFlashRedirect(
          "/admin/groups",
          t("error.selected_group_deleted"),
          false,
        )(response);
        expect(await listingGroups.getIds(listing.id)).toEqual([]);
      });

      test("handles empty selection gracefully", async () => {
        const group = await createTestGroup({
          name: "Empty Select",
          slug: "empty-select",
        });
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/add-listings`,
            {
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/groups/${group.id}`,
          "Listings added to group",
        )(response);
      });

      test("rejects adding listing with mismatched type", async () => {
        const group = await createTestGroup({
          name: "Type Check",
          slug: "type-check",
        });
        await createTestListing({
          groupId: group.id,
          listingType: "standard",
          name: "Standard In Group",
        });
        const dailyListing = await createTestListing({
          listingType: "daily",
          name: "Daily Ungrouped",
        });

        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/add-listings`,
            {
              csrf_token: csrfToken,
              listing_ids: String(dailyListing.id),
            },
            cookie,
          ),
        );
        await expectFlashRedirect(
          `/admin/groups/${group.id}`,
          t("error.group_listing_type_mismatch", { type: "standard" }),
          false,
        )(response);

        // Verify listing was NOT assigned
        expect(await listingGroups.getIds(dailyListing.id)).toEqual([]);
      });
    });
  },
);
