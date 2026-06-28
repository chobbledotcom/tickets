import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb } from "#shared/db/client.ts";
import {
  decryptAdminLevel,
  getUserByInviteCode,
  getUserByUsername,
  invalidateUsersCache,
} from "#shared/db/users.ts";
import {
  awaitTestRequest,
  buildCreateListingForm,
  createTestEditorSession,
  createTestGroup,
  createTestInvite,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  getTestSession,
  mockFormRequest,
  mockMultipartRequest,
  testListingInput,
} from "#test-utils";

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
  data: Record<string, string>,
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

      const allowed: Array<[string, string]> = [
        ["listings index", "/admin/listings"],
        ["new listing", "/admin/listing/new"],
        ["edit listing", `/admin/listing/${listing.id}/edit`],
        ["duplicate listing", `/admin/listing/${listing.id}/duplicate`],
        ["groups index", "/admin/groups"],
        ["new group", "/admin/groups/new"],
        ["edit group", `/admin/groups/${group.id}/edit`],
        ["site home", "/admin/site"],
        ["site contact", "/admin/site/contact"],
        ["site order", "/admin/site/order"],
      ];
      for (const [label, path] of allowed) {
        const response = await getAs(path, cookie);
        expect(response.status, `${label} (${path})`).toBe(200);
      }
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

      const forbidden: Array<[string, string]> = [
        ["listing detail (attendees)", `/admin/listing/${listing.id}`],
        ["attendee CSV", `/admin/listing/${listing.id}/attendees.csv`],
        ["listings CSV", "/admin/listings/csv"],
        ["group detail (attendees)", `/admin/groups/${group.id}`],
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

  describe("keyless security", () => {
    test("editor session derives no private key", async () => {
      const { cookie } = await createTestEditorSession();
      // The group detail page is the canonical private-key consumer; an editor's
      // keyless session can't open it (fails closed) — proving the key is absent.
      const group = await createTestGroup();
      await createTestListing({ groupId: group.id });
      const response = await getAs(`/admin/groups/${group.id}`, cookie);
      expect(response.status).toBe(403);
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
    test("listings table hides money columns, links to edit, no CSV export", async () => {
      const { cookie } = await createTestEditorSession();
      const listing = await createTestListing();
      const html = await (await getAs("/admin/listings", cookie)).text();

      expect(html).toContain(`href="/admin/listing/${listing.id}/edit"`);
      expect(html).not.toContain(`href="/admin/listing/${listing.id}"`);
      expect(html).not.toContain("/admin/listings/csv");
      expect(html).not.toContain("Revenue");
      expect(html).not.toContain("Profit");
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

  describe("login, invite, activation, status", () => {
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
  return Number(
    (result.rows[0] as Record<string, unknown>).booked_quantity,
  );
};

/** Fetch the owner-only users management page. */
const adminUsersHtml = async (): Promise<Response> => {
  const { cookie } = await getTestSession();
  return getAs("/admin/users", cookie);
};
