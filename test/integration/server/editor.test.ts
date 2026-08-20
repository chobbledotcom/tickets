import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import {
  decryptAdminLevel,
  getUserByInviteCode,
  getUserByUsername,
  invalidateUsersCache,
} from "#db/users.ts";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestInvite,
  createTestSitePage,
} from "#test-utils/db-helpers/misc.ts";
import { testListingInput } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockMultipartRequest,
} from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  createTestManagerSession,
  getTestSession,
} from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** GET `path` with the given session cookie. */
const getAs = (path: string, cookie: string): Promise<Response> =>
  awaitTestRequest(path, { cookie });

/** POST a urlencoded form to `path` with a signed CSRF token and cookie. */
const postFormAs = async (
  path: string,
  cookie: string,
  data: Record<string, string> = {},
): Promise<Response> => {
  const csrf_token = await signCsrfToken();
  return handleRequest(mockFormRequest(path, { ...data, csrf_token }, cookie));
};

/** POST a multipart form to `path` with a signed CSRF token and cookie. */
const postMultipartAs = async (
  path: string,
  cookie: string,
  data: TestFormValues,
): Promise<Response> => {
  const csrf_token = await signCsrfToken();
  return handleRequest(
    mockMultipartRequest(path, { ...data, csrf_token }, cookie),
  );
};

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
      expect(response.headers.get("location")).toContain("/admin/listings");
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
      expect(created.headers.get("location")).toContain("/admin/site/pages/");
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
      expect(baseHtml).toContain("listing-edit-form");

      // The listing Actions tab IS open to an editor, but only Duplicate and
      // Export — every staff-only action (email/refund/deactivate/delete) is
      // absent, not merely unlinked.
      const listingActions = await getAs(
        `/admin/listing/${listing.id}/actions`,
        cookie,
      );
      expect(listingActions.status).toBe(200);
      const listingActionsHtml = await listingActions.text();
      expect(listingActionsHtml).toContain(
        `/admin/listing/${listing.id}/duplicate`,
      );
      expect(listingActionsHtml).toContain(
        `/admin/listing/${listing.id}/export.json`,
      );
      expect(listingActionsHtml).not.toContain(
        `/admin/listing/${listing.id}/deactivate`,
      );
      expect(listingActionsHtml).not.toContain(
        `/admin/listing/${listing.id}/delete`,
      );
      expect(listingActionsHtml).not.toContain("/admin/emails");

      // Groups are the same tabbed shape: the staff-only tabs (Overview,
      // Attendees) 404 for an editor, and the base URL resolves to the
      // Edit tab they may use.
      for (const tab of ["attendees"]) {
        const hidden = await getAs(`/admin/groups/${group.id}/${tab}`, cookie);
        expect(hidden.status, `hidden group ${tab} tab`).toBe(404);
      }
      const groupBase = await getAs(`/admin/groups/${group.id}`, cookie);
      expect(groupBase.status).toBe(200);
      expect(await groupBase.text()).toContain(
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
      expect(groupActionsHtml).toContain(
        `/admin/groups/${group.id}/export.json`,
      );
      expect(groupActionsHtml).not.toContain(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      expect(groupActionsHtml).not.toContain(
        `/admin/groups/${group.id}/delete`,
      );
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
    test("editor group create/edit returns to the edit form, not the detail page", async () => {
      const { cookie } = await createTestEditorSession();

      const createResp = await postFormAs("/admin/groups", cookie, {
        description: "",
        max_attendees: "0",
        name: "Editor Group",
        terms_and_conditions: "",
      });
      expect(createResp.status).toBe(302);
      expect(createResp.headers.get("location")).toMatch(
        /\/admin\/groups\/\d+\/edit/,
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
      expect(editResp.headers.get("location")).toContain(
        `/admin/groups/${group.id}/edit`,
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

      // Editor edit succeeds and returns to the edit form (not the forbidden
      // detail page), but the crafted aggregate fields are ignored.
      const editorResp = await postMultipartAs(
        `/admin/listing/${listing.id}/edit`,
        cookie,
        editBody,
      );
      expect(editorResp.status).toBe(302);
      expect(editorResp.headers.get("location")).toContain(
        `/admin/listing/${listing.id}/edit`,
      );
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

      expect(html).toContain(`href="/admin/listing/${listing.id}/edit"`);
      expect(html).not.toContain(`href="/admin/listing/${listing.id}"`);
      expect(html).not.toContain("/admin/listings/csv");
    });

    test("listing edit page hides the income/ledger sections", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const html = await (
        await getAs(`/admin/listing/${listing.id}/edit`, cookie)
      ).text();

      // The income-adjust form and the running-totals aggregate inputs are gone.
      expect(html).not.toContain(`/admin/listing/${listing.id}/income`);
      expect(html).not.toContain('name="booked_quantity"');
    });

    test("groups list links editors to the edit form, not the detail page", async () => {
      const { cookie } = await createTestEditorSession();
      const group = await createTestGroup();
      const html = await (await getAs("/admin/groups", cookie)).text();
      expect(html).toContain(`href="/admin/groups/${group.id}/edit"`);
      expect(html).not.toContain(`href="/admin/groups/${group.id}"`);
    });

    test("nav shows only the editor's reachable sections", async () => {
      await enablePublicSite();
      const { cookie } = await createTestEditorSession();
      const html = await (await getAs("/admin/listings", cookie)).text();

      expect(html).toContain('href="/admin/listings"');
      expect(html).toContain('href="/admin/groups"');
      expect(html).toContain('href="/admin/site"');
      for (const forbidden of [
        '"/admin/users"',
        '"/admin/ledger"',
        '"/admin/settings"',
        '"/admin/attendees"',
        '"/admin/calendar"',
        '"/admin/modifiers"',
        '"/admin/deliveries"',
      ]) {
        expect(html, `nav must not link ${forbidden}`).not.toContain(forbidden);
      }
    });

    test("each editor section shows its own create link only inside it", async () => {
      const { cookie } = await createTestEditorSession();

      // On the Listings section, Add Listing shows but Add Group does not —
      // create links live in their own section's sub-nav, not on every page.
      const listingsHtml = await (
        await getAs("/admin/listings", cookie)
      ).text();
      expect(listingsHtml).toContain('href="/admin/listing/new"');
      expect(listingsHtml).not.toContain('href="/admin/groups/new"');

      // ...and the reverse on the Groups section.
      const groupsHtml = await (await getAs("/admin/groups", cookie)).text();
      expect(groupsHtml).toContain('href="/admin/groups/new"');
      expect(groupsHtml).not.toContain('href="/admin/listing/new"');
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
      expect(editorSave.headers.get("location")).toContain("/admin/site");

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

  describe("PII safety: webhooks, previews, footer, guide", () => {
    test("an editor edit can't bake an inherited webhook default into the row", async () => {
      // The owner sets a webhook *default*; this listing inherits it live, but
      // keeps its own stored webhook underneath.
      await settings.update.listingDefaults({
        webhookUrl: "https://default.example/hook",
      });
      const listing = await createTestListing({
        useDefaults: true,
        webhookUrl: "https://own.example/hook",
      });
      // Live, the listing resolves to the inherited default…
      expect((await getListingWithCount(listing.id))!.webhook_url).toBe(
        "https://default.example/hook",
      );

      // …but an editor saving an edit must neither set their crafted URL nor
      // freeze the inherited default into the row.
      const { cookie } = await createTestEditorSession();
      const editorResp = await postMultipartAs(
        `/admin/listing/${listing.id}/edit`,
        cookie,
        {
          ...buildCreateListingForm(testListingInput()),
          slug: listing.slug,
          webhook_url: "https://attacker.example/steal",
        },
      );
      expect(editorResp.status).toBe(302);

      // Clearing the default reveals the listing's preserved own webhook —
      // proving the editor's save materialised neither the default nor the
      // crafted URL.
      await settings.update.listingDefaults({});
      expect((await getListingWithCount(listing.id))!.webhook_url).toBe(
        "https://own.example/hook",
      );
    });

    test("an editor edit can't toggle a listing's use_defaults inheritance", async () => {
      // A webhook default makes the use_defaults flag control PII delivery, so
      // editors must not flip it.
      await settings.update.listingDefaults({
        webhookUrl: "https://default.example/hook",
      });
      const listing = await createTestListing({
        name: "Inherits",
        useDefaults: true,
      });

      // The editor's form omits use_defaults (the toggle is hidden from them);
      // a naive parse would read that as "off" and stop the webhook.
      const { cookie } = await createTestEditorSession();
      const resp = await postMultipartAs(
        `/admin/listing/${listing.id}/edit`,
        cookie,
        { ...buildCreateListingForm(testListingInput()), slug: listing.slug },
      );
      expect(resp.status).toBe(302);
      // The flag is preserved, so the listing keeps inheriting.
      expect((await getListingWithCount(listing.id))!.use_defaults).toBe(true);

      // The owner submitting the same body DOES turn it off — proving the lock
      // is what blocks the editor, not an unrelated validation failure.
      const { cookie: ownerCookie } = await getTestSession();
      await postMultipartAs(`/admin/listing/${listing.id}/edit`, ownerCookie, {
        ...buildCreateListingForm(testListingInput()),
        slug: listing.slug,
      });
      expect((await getListingWithCount(listing.id))!.use_defaults).toBe(false);
    });

    test("editor listing create lands on the edit page so flashes are shown", async () => {
      const { cookie } = await createTestEditorSession();
      const resp = await postMultipartAs(
        "/admin/listing",
        cookie,
        buildCreateListingForm(testListingInput()),
      );
      expect(resp.status).toBe(302);
      // Not the dashboard (/admin) or bare /admin/listings, which render no
      // Flash for editors — the new listing's edit page does.
      expect(resp.headers.get("location")).toMatch(
        /\/admin\/listing\/\d+\/edit/,
      );
    });

    test("editors can use the markdown preview endpoint", async () => {
      const { cookie } = await createTestEditorSession();
      const response = await postFormAs("/admin/markdown-preview", cookie, {
        content: "# Hello",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<h1>Hello</h1>");
    });

    test("the admin guide stays staff-only (its body links to staff pages)", async () => {
      const { cookie } = await createTestEditorSession();
      const response = await getAs("/admin/guide", cookie);
      expect(response.status).toBe(403);
    });

    test("the markdown formatting help page is reachable by editors", async () => {
      const { cookie } = await createTestEditorSession();
      const response = await getAs("/admin/formatting", cookie);
      expect(response.status).toBe(200);
      // The editor-safe formatting section, not the full staff guide.
      const html = await response.text();
      expect(html).toContain("Markdown");
      // The markdown field hint on the editor's listing edit form points here,
      // so "Formatting help" never dead-ends on the staff-only guide.
      const editHtml = await (
        await getAs(
          `/admin/listing/${(await createTestListing()).id}/edit`,
          cookie,
        )
      ).text();
      expect(editHtml).toContain('href="/admin/formatting"');
      expect(editHtml).not.toContain('href="/admin/guide#text-formatting"');
    });

    test("editor footer shows only logout (no staff-only log or guide links)", async () => {
      const { cookie } = await createTestEditorSession();
      const html = await (await getAs("/admin/listings", cookie)).text();
      expect(html).toContain('href="/admin/logout"');
      expect(html).not.toContain('href="/admin/log"');
      expect(html).not.toContain('href="/admin/guide"');
    });

    test("editors do not get the staff SQL/cache debug footer", async () => {
      const { cookie: editorCookie } = await createTestEditorSession();
      const { cookie: ownerCookie } = await getTestSession();
      // Admin GETs enable query logging; the owner's page therefore renders the
      // debug footer — proving the menu is live on this path…
      const ownerHtml = await (
        await getAs("/admin/listings", ownerCookie)
      ).text();
      expect(ownerHtml).toContain("debug-menu");
      // …but the editor's identical page must not (the unlock is staff-only).
      const editorHtml = await (
        await getAs("/admin/listings", editorCookie)
      ).text();
      expect(editorHtml).not.toContain("debug-menu");
    });
  });

  describe("login, invite, activation, status", () => {
    // The journey is told by `@story:access.what-an-editor-can-do`; this
    // stays because it is the only cover of the keyless login branch, which a
    // Cucumber run does not count towards.
    test("an editor logs in to a keyless session and lands on listings", async () => {
      await createTestEditorSession({
        password: "editorlogin123",
        token: "ignored-editor-login",
        username: "loginEditor",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          csrf_token: await signCsrfToken(),
          password: "editorlogin123",
          username: "loginEditor",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/listings");
      expect(response.headers.get("set-cookie")).toContain(
        getSessionCookieName(),
      );
    });

    test("inviting an editor stores no DATA_KEY handoff", async () => {
      await createTestInvite("invitedEditor", "editor");
      invalidateUsersCache();
      const user = await getUserByUsername("invitedEditor");
      expect(user).not.toBeNull();
      expect(await decryptAdminLevel(user!)).toBe("editor");
      // No handoff and no data key — the editor will activate keyless.
      expect(user!.invite_wrapped_data_key).toBeNull();
      expect(user!.wrapped_data_key).toBeNull();
      expect(user!.invite_code_hash).not.toBeNull();
    });

    test("an editor activates keyless via /join and then reads as Active", async () => {
      const { inviteCode } = await createTestInvite("joinEditor", "editor");

      // The keyless invite is accepted by /join (no handoff required).
      const joinGet = await handleRequest(
        new Request(`http://localhost/join/${inviteCode}`, {
          headers: { host: "localhost" },
        }),
      );
      expect(joinGet.status).toBe(200);

      const joinPost = await handleRequest(
        mockFormRequest(`/join/${inviteCode}`, {
          csrf_token: await signCsrfToken(),
          password: "joinpass12345",
          password_confirm: "joinpass12345",
        }),
      );
      expect(joinPost.status).toBe(302);
      expect(joinPost.headers.get("location")).toContain("/join/complete");

      invalidateUsersCache();
      const user = await getUserByUsername("joinEditor");
      // Activated: password set, still no data key.
      expect(user!.password_hash).not.toBe("");
      expect(user!.wrapped_data_key).toBeNull();
      // The invite is consumed (single-use) — its code no longer resolves.
      expect(await getUserByInviteCode(inviteCode)).toBeNull();

      // The owner's users page shows the activated editor as Active.
      const usersHtml = await (await adminUsersHtml()).text();
      expect(usersHtml).toContain("joineditor");
      expect(usersHtml).toContain("Active");
    });
  });
});

/** Read a listing's stored booked_quantity directly. */
const bookedQuantity = async (id: number): Promise<number> => {
  const result = await getDb().execute({
    args: [id],
    sql: "SELECT booked_quantity FROM listings WHERE id = ?",
  });
  return Number((result.rows[0] as Record<string, unknown>).booked_quantity);
};

/** Fetch the owner-only users management page. */
const adminUsersHtml = async (): Promise<Response> => {
  const { cookie } = await getTestSession();
  return getAs("/admin/users", cookie);
};
