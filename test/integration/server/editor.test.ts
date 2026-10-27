import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  createTestManagerSession,
  getTestSession,
  postFormAs,
} from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import { bookedQuantity, getAs, postMultipartAs } from "./editor/helpers.ts";

describeWithEnv("server (editor role)", { db: true }, () => {
  describe("allowed pages", () => {
    test("editor can open the content pages they own", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const group = await createTestGroup();

      const allowed: [string, string][] = [
        ["listings index", "/admin/listings"],
        ["new listing", "/admin/listing/new"],
        ["edit listing", `/admin/listing/${listing.id}/edit`],
        ["duplicate listing", `/admin/listing/${listing.id}/duplicate`],
        ["groups index", "/admin/groups"],
        ["new group", "/admin/groups/new"],
        ["edit group", `/admin/groups/${group.id}/edit`],
        ["catalog import", "/admin/catalog/import"],
        ["listing export", `/admin/listing/${listing.id}/export.json`],
        ["group export", `/admin/groups/${group.id}/export.json`],
        ["site home", "/admin/site"],
        ["site contact", "/admin/site/contact"],
        ["site order", "/admin/site/order"],
      ];
      for (const [label, path] of allowed) {
        const response = await getAs(path, cookie);
        expect(response.status, `${label} (${path})`).toBe(200);
      }
    });

    test("editor can import a listing from a JSON file", async () => {
      const { cookie } = await createTestEditorSession();
      const csrf_token = await signCsrfToken();
      const blob = {
        kind: "listing",
        listing: { maxAttendees: 5, name: "Editor Import" },
        version: 1,
      };
      const response = await handleRequest(
        mockMultipartRequest("/admin/catalog/import", { csrf_token }, cookie, {
          contentType: "application/json",
          data: new TextEncoder().encode(JSON.stringify(blob)),
          fieldName: "catalog_file",
          name: "listing.json",
        }),
      );
      expect(response.status).toBe(302);
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "/admin/listings",
      );
      const { getAllListings } = await import("#db/listings/records.ts");
      expect(
        (await getAllListings()).some((l) => l.name === "Editor Import"),
      ).toBe(true);
    });

    test("editor renders every Site → Pages screen and can create; manager is 403", async () => {
      const { cookie } = await createTestEditorSession();
      const page = await createTestSitePage("role-matrix");
      const screens: [string, string][] = [
        ["pages list", "/admin/site/pages"],
        ["new page", "/admin/site/pages/new"],
        ["edit page", `/admin/site/pages/${page.id}/edit`],
        ["delete page", `/admin/site/pages/${page.id}/delete`],
      ];
      for (const [label, path] of screens) {
        const response = await getAs(path, cookie);
        expect(response.status, `editor ${label} (${path})`).toBe(200);
      }
      // The pages CRUD is SITE_FORM-gated, so an editor's POST goes through…
      const created = await postFormAs("/admin/site/pages", cookie, {
        name: "By Editor",
        slug: "by-editor",
      });
      expect(created.status).toBe(302);
      assertStringIncludes(
        created.headers.get("location") ?? "",
        "/admin/site/pages/",
      );
      // …while a manager — content is not their remit (role downgrade removes
      // access) — is 403 on every screen and on the write.
      const managerCookie = await createTestManagerSession();
      for (const [label, path] of screens) {
        const response = await getAs(path, managerCookie);
        expect(response.status, `manager ${label} (${path})`).toBe(403);
      }
      const denied = await postFormAs("/admin/site/pages", managerCookie, {
        name: "By Manager",
        slug: "by-manager",
      });
      expect(denied.status).toBe(403);
    });

    test("editor is redirected from the dashboard to listings", async () => {
      const { cookie } = await createTestEditorSession();
      const response = await getAs("/admin/", cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/listings");
    });
  });

  describe("forbidden pages", () => {
    test("editor is blocked from staff/owner pages", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const group = await createTestGroup();

      const forbidden: [string, string][] = [
        ["attendee CSV", `/admin/listing/${listing.id}/attendees.csv`],
        ["listings CSV", "/admin/listings/csv"],
        ["attendees", "/admin/attendees"],
        ["calendar", "/admin/calendar"],
        ["ledger", "/admin/ledger"],
        ["users", "/admin/users"],
        ["settings", "/admin/settings"],
        ["deliveries", "/admin/deliveries"],
        ["activity log", "/admin/log"],
      ];
      for (const [label, path] of forbidden) {
        const response = await getAs(path, cookie);
        expect(response.status, `${label} (${path})`).toBe(403);
      }

      // The refusal that a manager meets when they type an owner-only URL
      // says who can open it, instead of the bare word "Forbidden".
      const usersResponse = await getAs("/admin/users", cookie);
      const usersBody = await usersResponse.text();
      assertStringIncludes(usersBody, t("auth.forbidden_owner_only"));

      // On the tabbed listing page the staff-only tabs (roster, activity) are
      // hidden — visibility IS authorization, so naming one 404s rather than
      // exposing that it exists. The editor's default landing tab is Edit
      // (the base URL), which they may use.
      for (const tab of ["attendees", "activity"]) {
        const hidden = await getAs(
          `/admin/listing/${listing.id}/${tab}`,
          cookie,
        );
        expect(hidden.status, `hidden ${tab} tab`).toBe(404);
      }
      // Scanner isn't part of this tab framework at all — it's served by its
      // own route (scanner.ts), staff-gated there, so it 403s rather than 404s.
      const scanner = await getAs(
        `/admin/listing/${listing.id}/scanner`,
        cookie,
      );
      expect(scanner.status).toBe(403);
      const base = await getAs(`/admin/listing/${listing.id}`, cookie);
      const baseHtml = await base.text();
      expect(base.status).toBe(200);
      assertStringIncludes(baseHtml, "listing-edit-form");

      // The listing Actions tab IS open to an editor, but only Duplicate and
      // Export — every staff-only action (email/refund/deactivate/delete) is
      // absent, not merely unlinked.
      const listingActions = await getAs(
        `/admin/listing/${listing.id}/actions`,
        cookie,
      );
      expect(listingActions.status).toBe(200);
      const listingActionsHtml = await listingActions.text();
      assertStringIncludes(
        listingActionsHtml,
        `/admin/listing/${listing.id}/duplicate`,
      );
      assertStringIncludes(
        listingActionsHtml,
        `/admin/listing/${listing.id}/export.json`,
      );
      assert(
        !listingActionsHtml.includes(`/admin/listing/${listing.id}/deactivate`),
      );
      assert(
        !listingActionsHtml.includes(`/admin/listing/${listing.id}/delete`),
      );
      assert(!listingActionsHtml.includes("/admin/emails"));

      // Groups are the same tabbed shape: the staff-only tabs (Overview,
      // Attendees) 404 for an editor, and the base URL resolves to the
      // Edit tab they may use.
      for (const tab of ["attendees"]) {
        const hidden = await getAs(`/admin/groups/${group.id}/${tab}`, cookie);
        expect(hidden.status, `hidden group ${tab} tab`).toBe(404);
      }
      const groupBase = await getAs(`/admin/groups/${group.id}`, cookie);
      expect(groupBase.status).toBe(200);
      assertStringIncludes(
        await groupBase.text(),
        `action="/admin/groups/${group.id}/edit"`,
      );

      // The group Actions tab is open to an editor too, but only Export —
      // Bulk actions and Delete are staff-only.
      const groupActions = await getAs(
        `/admin/groups/${group.id}/actions`,
        cookie,
      );
      expect(groupActions.status).toBe(200);
      const groupActionsHtml = await groupActions.text();
      assertStringIncludes(
        groupActionsHtml,
        `/admin/groups/${group.id}/export.json`,
      );
      assert(
        !groupActionsHtml.includes(`/admin/groups/${group.id}/bulk-actions`),
      );
      assert(!groupActionsHtml.includes(`/admin/groups/${group.id}/delete`));
    });

    test("editor POSTs to forbidden actions are rejected", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const group = await createTestGroup();

      // Group delete is destructive and stays staff-only.
      const deleteResp = await postFormAs(
        `/admin/groups/${group.id}/delete`,
        cookie,
        { confirm_name: group.name },
      );
      expect(deleteResp.status).toBe(403);

      // The income (money) adjust is owner-only.
      const incomeResp = await postFormAs(
        `/admin/listing/${listing.id}/income`,
        cookie,
        { income: "5" },
      );
      expect(incomeResp.status).toBe(403);

      // General settings saves are owner-only.
      const settingsResp = await postFormAs("/admin/settings", cookie, {
        currency_code: "USD",
      });
      expect(settingsResp.status).toBe(403);

      // The delivery run-sheet mark action excludes editors.
      const markResp = await postFormAs("/admin/deliveries/mark", cookie, {
        attendee_id: "1",
        done: "true",
        listing_id: "1",
      });
      expect(markResp.status).toBe(403);
    });
  });

  describe("group create/edit redirects", () => {
    test("editor group create and edit return to the group's own page", async () => {
      const { cookie } = await createTestEditorSession();

      const createResp = await postFormAs("/admin/groups", cookie, {
        description: "",
        max_attendees: "0",
        name: "Editor Group",
        terms_and_conditions: "",
      });
      // The group page opens on the first tab its viewer can see, which for
      // an editor is Edit, so the record's own page is where they land.
      expect(createResp.status).toBe(302);
      expect(createResp.headers.get("location")).toMatch(
        /\/admin\/groups\/\d+(\?|$)/,
      );

      const group = await createTestGroup({ name: "To Rename" });
      const editResp = await postFormAs(
        `/admin/groups/${group.id}/edit`,
        cookie,
        {
          description: "",
          max_attendees: "0",
          name: "Renamed By Editor",
          slug: group.slug,
          terms_and_conditions: "",
        },
      );
      expect(editResp.status).toBe(302);
      assertStringIncludes(
        editResp.headers.get("location") ?? "",
        `/admin/groups/${group.id}`,
      );
    });
  });

  describe("keyless security", () => {
    test("editor cannot reach the group's PII roster tab", async () => {
      const { cookie } = await createTestEditorSession();
      // The group Attendees tab is the canonical private-key consumer (it
      // decrypts the roster). It is staff-only, so an editor's keyless session
      // can never reach it — visibility is authorization, so it 404s rather than
      // exposing the decrypt path. The base URL resolves to the keyless Edit tab
      // instead, which needs no private key.
      const group = await createTestGroup();
      await createTestListing({ groupId: group.id });
      const roster = await getAs(`/admin/groups/${group.id}/attendees`, cookie);
      expect(roster.status).toBe(404);
      const base = await getAs(`/admin/groups/${group.id}`, cookie);
      expect(base.status).toBe(200);
    });

    test("editor cannot overwrite trigger-maintained booking aggregates", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const editBody = {
        ...buildCreateListingForm(testListingInput()),
        booked_quantity: "999",
        slug: listing.slug,
        tickets_count: "999",
      };

      // The editor's save succeeds and returns to the listing's own page,
      // but the crafted aggregate fields are ignored.
      const editorResp = await postMultipartAs(
        `/admin/listing/${listing.id}/edit`,
        cookie,
        editBody,
      );
      expect(editorResp.status).toBe(302);
      // The record page itself, not the edit form under it, which the
      // substring of the one is a substring of the other.
      expect(
        new URL(editorResp.headers.get("location") ?? "", "http://localhost")
          .pathname,
      ).toBe(`/admin/listing/${listing.id}`);
      expect(await bookedQuantity(listing.id)).toBe(0);

      // The same body submitted by the owner DOES apply the aggregate — proving
      // the test would catch a regression that dropped the editor guard.
      const { cookie: ownerCookie } = await getTestSession();
      const ownerResp = await postMultipartAs(
        `/admin/listing/${listing.id}/edit`,
        ownerCookie,
        editBody,
      );
      expect(ownerResp.status).toBe(302);
      expect(await bookedQuantity(listing.id)).toBe(999);
    });
  });

  describe("role-aware rendering", () => {
    // The money columns an editor must never see are proved by the story
    // `@story:access.what-an-editor-can-do`; this keeps the link shape and
    // the absent CSV export, which are not part of that journey.
    test("listings table links to edit and offers no CSV export", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const html = await (await getAs("/admin/listings", cookie)).text();

      assertStringIncludes(html, `href="/admin/listing/${listing.id}/edit"`);
      assert(!html.includes(`href="/admin/listing/${listing.id}"`));
      assert(!html.includes("/admin/listings/csv"));
    });

    test("listing edit page hides the income/ledger sections", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const html = await (
        await getAs(`/admin/listing/${listing.id}/edit`, cookie)
      ).text();

      // The income-adjust form and the running-totals aggregate inputs are gone.
      assert(!html.includes(`/admin/listing/${listing.id}/income`));
      assert(!html.includes('name="booked_quantity"'));
    });

    test("groups list links editors to the group's own page", async () => {
      // Following it lands them on Edit, the first tab an editor can see.
      const { cookie } = await createTestEditorSession();
      const group = await createTestGroup();
      const html = await (await getAs("/admin/groups", cookie)).text();
      assertStringIncludes(html, `href="/admin/groups/${group.id}"`);
    });

    test("nav shows only the editor's reachable sections", async () => {
      await enablePublicSite();
      const { cookie } = await createTestEditorSession();
      const html = await (await getAs("/admin/listings", cookie)).text();

      assertStringIncludes(html, 'href="/admin/listings"');
      assertStringIncludes(html, 'href="/admin/groups"');
      assertStringIncludes(html, 'href="/admin/site"');
      for (const forbidden of [
        '"/admin/users"',
        '"/admin/ledger"',
        '"/admin/settings"',
        '"/admin/attendees"',
        '"/admin/calendar"',
        '"/admin/modifiers"',
        '"/admin/deliveries"',
      ]) {
        assert(!html.includes(forbidden), `nav must not link ${forbidden}`);
      }
    });

    test("each editor section shows its own create link only inside it", async () => {
      const { cookie } = await createTestEditorSession();

      // On the Listings section, Add Listing shows but Add Group does not —
      // create links live in their own section's sub-nav, not on every page.
      const listingsHtml = await (
        await getAs("/admin/listings", cookie)
      ).text();
      assertStringIncludes(listingsHtml, 'href="/admin/listing/new"');
      assert(!listingsHtml.includes('href="/admin/groups/new"'));

      // ...and the reverse on the Groups section.
      const groupsHtml = await (await getAs("/admin/groups", cookie)).text();
      assertStringIncludes(groupsHtml, 'href="/admin/groups/new"');
      assert(!groupsHtml.includes('href="/admin/listing/new"'));
    });
  });

  describe("site editing roles", () => {
    test("editor can save site content; manager cannot", async () => {
      const { cookie: editorCookie } = await createTestEditorSession();
      const editorSave = await postFormAs("/admin/site", editorCookie, {
        homepage_text: "Edited by the editor",
        website_title: "Editor Site",
      });
      expect(editorSave.status).toBe(302);
      assertStringIncludes(
        editorSave.headers.get("location") ?? "",
        "/admin/site",
      );

      const managerCookie = await createTestManagerSession(
        "site-mgr-session",
        "sitemanager",
      );
      const managerGet = await getAs("/admin/site", managerCookie);
      expect(managerGet.status).toBe(403);
      const managerSave = await postFormAs("/admin/site", managerCookie, {
        homepage_text: "Manager attempt",
        website_title: "Manager Site",
      });
      expect(managerSave.status).toBe(403);
    });
  });
});
