import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import { setDemoModeForTest } from "#shared/demo-mode.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestEditorSession,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectStatus,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

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
        expect(html).toContain(`href="/admin/groups/${group.id}"`);
        expect(html).toContain(`href="/admin/groups/${group.id}/attendees"`);
        expect(html).toContain(`href="/admin/groups/${group.id}/edit"`);
        expect(html).toContain(`href="/admin/groups/${group.id}/actions"`);
        // The admin nav highlights the Groups section (navActive).
        expect(html).toContain('class="active" href="/admin/groups"');
      });

      test("Actions tab shows the export, bulk-actions, and delete links", async () => {
        const group = await createTestGroup({
          name: "Actions Group",
          slug: "actions-group",
        });
        const html = await (
          await adminGet(`/admin/groups/${group.id}/actions`)
        ).text();
        expect(html).toContain(`/admin/groups/${group.id}/export.json`);
        expect(html).toContain(`/admin/groups/${group.id}/bulk-actions`);
        expect(html).toContain(`/admin/groups/${group.id}/delete`);
        // Each action carries its icon (an empty icon name drops the <use> ref);
        // the nav renders none of these, so the refs are unique to the buttons.
        expect(html).toContain("#save");
        expect(html).toContain("#hammer");
        expect(html).toContain("#trash-2");
        // Delete is destructive, so it renders inside the danger zone (danger: true).
        expect(html).toContain("entity-danger-zone");
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
        expect(html).toContain(`action="/admin/groups/${group.id}/edit"`);
        expect(html).not.toContain("Public URL");
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

        expect(await getGroupIdsByListingId(listing1.id)).toEqual([]);
        expect(await getGroupIdsByListingId(listing2.id)).toEqual([]);

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

        expect(await getGroupIdsByListingId(listing1.id)).toContain(group.id);
        expect(await getGroupIdsByListingId(listing2.id)).toEqual([]);
        // The assignment is recorded in the activity log.
        const { getAllActivityLog } = await import("#test-utils");
        const log = await getAllActivityLog();
        expect(
          log.some((e) => e.message.includes("added to group 'Assign Group'")),
        ).toBe(true);
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
          "This group already contains standard listings — all listings in a group must be the same type",
          false,
        )(response);

        // Verify listing was NOT assigned
        expect(await getGroupIdsByListingId(dailyListing.id)).toEqual([]);
      });
    });
  },
);
