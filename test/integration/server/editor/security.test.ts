import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestInvite } from "#test-utils/db-helpers/misc.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  getTestSession,
  postFormAs,
} from "#test-utils/session.ts";
import { adminUsersHtml, getAs, postMultipartAs } from "./helpers.ts";

describeWithEnv("server (editor role) security", { db: true }, () => {
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

    test("editor listing create lands on the listing so flashes are shown", async () => {
      const { cookie } = await createTestEditorSession();
      const resp = await postMultipartAs(
        "/admin/listing",
        cookie,
        buildCreateListingForm(testListingInput()),
      );
      expect(resp.status).toBe(302);
      // Not the dashboard (/admin) or bare /admin/listings, which render no
      // Flash for editors — the new listing's own page does.
      expect(resp.headers.get("location")).toMatch(
        /\/admin\/listing\/\d+(\?|$)/,
      );
    });

    test("editors can use the markdown preview endpoint", async () => {
      const { cookie } = await createTestEditorSession();
      const response = await postFormAs("/admin/markdown-preview", cookie, {
        content: "# Hello",
      });
      expect(response.status).toBe(200);
      assertStringIncludes(await response.text(), "<h1>Hello</h1>");
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
      assertStringIncludes(html, "Markdown");
      // The markdown field hint on the editor's listing edit form points here,
      // so "Formatting help" never dead-ends on the staff-only guide.
      const editHtml = await (
        await getAs(
          `/admin/listing/${(await createTestListing()).id}/edit`,
          cookie,
        )
      ).text();
      assertStringIncludes(editHtml, 'href="/admin/formatting"');
      assert(!editHtml.includes('href="/admin/guide#text-formatting"'));
    });

    test("editor footer shows only logout (no staff-only log or guide links)", async () => {
      const { cookie } = await createTestEditorSession();
      const html = await (await getAs("/admin/listings", cookie)).text();
      assertStringIncludes(html, 'href="/admin/logout"');
      assert(!html.includes('href="/admin/log"'));
      assert(!html.includes('href="/admin/guide"'));
    });

    test("editors do not get the staff SQL/cache debug footer", async () => {
      const { cookie: editorCookie } = await createTestEditorSession();
      const { cookie: ownerCookie } = await getTestSession();
      // Admin GETs enable query logging; the owner's page therefore renders the
      // debug footer — proving the menu is live on this path…
      const ownerHtml = await (
        await getAs("/admin/listings", ownerCookie)
      ).text();
      assertStringIncludes(ownerHtml, "debug-menu");
      // …but the editor's identical page must not (the unlock is staff-only).
      const editorHtml = await (
        await getAs("/admin/listings", editorCookie)
      ).text();
      assert(!editorHtml.includes("debug-menu"));
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
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "/admin/listings",
      );
      assertStringIncludes(
        response.headers.get("set-cookie") ?? "",
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
      assertStringIncludes(
        joinPost.headers.get("location") ?? "",
        "/join/complete",
      );

      invalidateUsersCache();
      const user = await getUserByUsername("joinEditor");
      // Activated: password set, still no data key.
      expect(user!.password_hash).not.toBe("");
      expect(user!.wrapped_data_key).toBeNull();
      // The invite is consumed (single-use) — its code no longer resolves.
      expect(await getUserByInviteCode(inviteCode)).toBeNull();

      // The owner's users page shows the activated editor as Active.
      const usersHtml = await (await adminUsersHtml()).text();
      assertStringIncludes(usersHtml, "joineditor");
      assertStringIncludes(usersHtml, "Active");
    });
  });
});
