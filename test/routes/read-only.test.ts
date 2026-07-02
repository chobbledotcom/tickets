import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { allTransfers } from "#shared/accounting/queries.ts";
import { readOnlyPage } from "#templates/public.tsx";
import { describeWithEnv, jsonRequest, mockRequest } from "#test-utils";

/** POST a urlencoded form body to `path` (defaults to a trivial field). */
const postForm = (path: string, body = "name=test"): Promise<Response> =>
  handleRequest(
    mockRequest(path, {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }),
  );

/** Assert a response is the read-only guard's 302 → /read-only redirect. */
const expectReadOnlyRedirect = (res: Response): void => {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/read-only");
};

/** Assert a JSON API response is the read-only guard's 403 with message. */
const expectReadOnly403 = async (res: Response): Promise<void> => {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("This site is in read-only mode");
};

describeWithEnv(
  "read-only mode",
  { db: true, env: { READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" } },
  () => {
    test("GET /read-only returns the read-only page", async () => {
      const res = await handleRequest(mockRequest("/read-only"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("This site is in read-only mode.");
    });

    test("readOnlyPage contains the expected message", () => {
      const html = readOnlyPage();
      expect(html).toContain("This site is in read-only mode.");
    });

    test("readOnlyPage includes renewal link when RENEWAL_URL is set", () => {
      Deno.env.set("RENEWAL_URL", "https://example.com/renew");
      try {
        const html = readOnlyPage();
        expect(html).toContain("Renew now");
        expect(html).toContain("https://example.com/renew");
      } finally {
        Deno.env.delete("RENEWAL_URL");
      }
    });

    test("readOnlyPage omits renewal link when RENEWAL_URL is not set", () => {
      Deno.env.delete("RENEWAL_URL");
      const html = readOnlyPage();
      expect(html).not.toContain("Renew now");
    });

    const api403Cases: ReadonlyArray<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [
      { body: { name: "test" }, method: "POST", path: "/api/admin/listings" },
      { body: { name: "test" }, method: "PUT", path: "/api/admin/listings/1" },
      {
        body: { name: "test" },
        method: "POST",
        path: "/api/listings/my-listing/book",
      },
    ];
    for (const { body, method, path } of api403Cases) {
      test(`${method} ${path} returns 403 JSON`, async () => {
        await expectReadOnly403(
          await handleRequest(jsonRequest(path, { body, method })),
        );
      });
    }

    test("DELETE /api/admin/listings/1 returns 403 JSON", async () => {
      const res = await handleRequest(
        jsonRequest("/api/admin/listings/1", { method: "DELETE" }),
      );
      expect(res.status).toBe(403);
    });

    test("GET /api/admin/listings is allowed", async () => {
      const res = await handleRequest(jsonRequest("/api/admin/listings"));
      // Should not be 403 — may be 401 (no auth) but not blocked by read-only
      expect(res.status).not.toBe(403);
    });

    const getRedirectPaths = [
      "/admin/listing/new",
      "/admin/listing/42/edit",
      "/admin/listing/42/duplicate",
      "/admin/groups/new",
      "/admin/groups/7/edit",
      "/admin/attendees/new",
      "/admin/ledger/attendee/42/add",
      "/admin/ledger/entries/9/edit",
    ];
    for (const path of getRedirectPaths) {
      test(`GET ${path} redirects to /read-only`, async () => {
        expectReadOnlyRedirect(await handleRequest(mockRequest(path)));
      });
    }

    const postRedirectCases: ReadonlyArray<{ path: string; body?: string }> = [
      { path: "/ticket/my-listing" },
      { path: "/admin/listing" },
      { path: "/admin/groups" },
      { path: "/admin/listing/42/attendee" },
      { path: "/admin/attendees/new" },
      { body: "listing_ids=1", path: "/admin/groups/5/add-listings" },
      { body: "child_listing_ids=1", path: "/admin/listing/42/children" },
    ];
    for (const { body, path } of postRedirectCases) {
      test(`POST ${path} redirects to /read-only`, async () => {
        expectReadOnlyRedirect(await postForm(path, body));
      });
    }

    /** POST a form body to `path`, asserting it is blocked (redirect to
     * /read-only) by the read-only guard AND that it posted no ledger leg — the
     * guard runs before the handler, so a blocked ledger-mutating correction
     * (decision 14) must never reach the transfers table. */
    const expectBlockedNoLedgerLeg = async (path: string): Promise<void> => {
      expectReadOnlyRedirect(await postForm(path, "income=5.00"));
      // The correction was blocked before it could post a writeoff adjustment.
      expect((await allTransfers()).length).toBe(0);
    };

    test("POST /admin/listing/42/income is blocked and posts no ledger leg", async () => {
      await expectBlockedNoLedgerLeg("/admin/listing/42/income");
    });

    test("POST /admin/modifiers/7/revenue is blocked and posts no ledger leg", async () => {
      await expectBlockedNoLedgerLeg("/admin/modifiers/7/revenue");
    });

    test("POST /admin/attendees/42 (balance correction) redirects to /read-only", async () => {
      // The unified attendee edit posts a writeoff balance correction, so it
      // must be blocked read-only. The bare-id pattern ends in `$`, so it matches
      // only the edit endpoint, not its `/merge` or `/refresh-payment` sub-routes.
      await expectBlockedNoLedgerLeg("/admin/attendees/42");
    });

    const ledgerMutationPaths = [
      "/admin/ledger/attendee/42/add",
      "/admin/ledger/entries/9/edit",
      "/admin/ledger/entries/9/delete",
    ];
    for (const path of ledgerMutationPaths) {
      test(`POST ${path} is blocked and posts no ledger leg`, async () => {
        await expectBlockedNoLedgerLeg(path);
      });
    }

    test("GET / is not blocked by read-only guard", async () => {
      const res = await handleRequest(mockRequest("/"));
      // May redirect to /admin/login if public site is disabled, but not to /read-only
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    test("GET /listings is not blocked by read-only guard", async () => {
      const res = await handleRequest(mockRequest("/listings"));
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    test("groups on listings page show Registration Closed in read-only mode", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      const { groupsTable, computeGroupSlugIndex, assignListingsToGroup } =
        await import("#shared/db/groups.ts");
      const { listingsTable, computeSlugIndex } = await import(
        "#shared/db/listings.ts"
      );
      await settings.update.showPublicSite(true);
      const slugIndex = await computeGroupSlugIndex("ro-group");
      const group = await groupsTable.insert({
        hidden: false,
        maxAttendees: 0,
        name: "Read Only Group",
        slug: "ro-group",
        slugIndex,
        termsAndConditions: "",
      });
      const roListing = await listingsTable.insert({
        maxAttendees: 50,
        maxPrice: 0,
        name: "RO Listing",
        slug: "ro-listing",
        slugIndex: await computeSlugIndex("ro-listing"),
      });
      await assignListingsToGroup([roListing.id], group.id);
      const res = await handleRequest(mockRequest("/listings"));
      const html = await res.text();
      expect(html).toContain("Read Only Group");
      expect(html).toContain("Registration Closed");
    });

    test("GET /ticket/my-listing is allowed (view form)", async () => {
      const res = await handleRequest(mockRequest("/ticket/my-listing"));
      // 404 (no such listing) is fine — not blocked by read-only
      expect(res.status).not.toBe(302);
    });

    test("POST /admin/login is not blocked (safe list)", async () => {
      const res = await handleRequest(
        mockRequest("/admin/login", {
          body: "password=test",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
      );
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    // Default-deny: routes not on the safe list are now blocked even when they
    // were not explicitly listed in the old blocklist.
    const newlyBlockedPostPaths = [
      "/admin/servicing/new",
      "/admin/settings/email",
      "/admin/users",
    ];
    for (const path of newlyBlockedPostPaths) {
      test(`POST ${path} is blocked by default-deny`, async () => {
        expectReadOnlyRedirect(await postForm(path));
      });
    }

    // DELETE mutations (non-API) are now blocked by default-deny.
    const deleteBlockedPaths = [
      "/admin/listing/1/delete",
      "/admin/listing/1/attendee/2/delete",
    ];
    for (const path of deleteBlockedPaths) {
      test(`DELETE ${path} is blocked by default-deny`, async () => {
        expectReadOnlyRedirect(
          await handleRequest(mockRequest(path, { method: "DELETE" })),
        );
      });
    }

    // Safe-list routes must pass through the guard even in read-only mode.
    // The response may be 4xx (no auth / bad payload) but must not be 302 → /read-only.
    const safePostPaths = [
      "/admin/logout",
      "/renew",
      "/pay/some-token",
      "/payment/webhook",
      "/v1/devices/abc/registrations/pass.com/tok",
      "/v1/log",
      "/sms/webhook",
      "/join/some-code",
      "/unsubscribe",
      "/contact",
      "/admin/support",
      "/instance/site-credentials",
      "/scheduled",
      "/admin/backup/create",
      "/checkin/abc123+def456",
      "/admin/listing/42/attendee/99/checkin",
      "/admin/listing/42/scan",
      "/admin/attendees/99/refresh-payment",
      "/admin/deliveries/mark",
    ];
    for (const path of safePostPaths) {
      test(`POST ${path} is not blocked by read-only guard`, async () => {
        const res = await postForm(path);
        expect(res.headers.get("location")).not.toBe("/read-only");
      });
    }

    test("DELETE /v1/devices/abc/registrations/pass.com/tok is not blocked (wallet protocol)", async () => {
      const res = await handleRequest(
        mockRequest("/v1/devices/abc/registrations/pass.com/tok", {
          method: "DELETE",
        }),
      );
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    // POST /read-only is not on the safe list, so the default-deny guard
    // blocks it with a redirect (same as any other unguarded mutation).
    test("POST /read-only is blocked by default-deny guard", async () => {
      const res = await handleRequest(
        mockRequest("/read-only", {
          body: "test=1",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
      );
      expectReadOnlyRedirect(res);
    });

    // HEAD is not a mutating method, so it passes the guard and reaches the
    // /read-only prefix handler, which only handles GET — returning null → 404.
    test("HEAD /read-only returns 404 (handler only handles GET)", async () => {
      const res = await handleRequest(
        mockRequest("/read-only", { method: "HEAD" }),
      );
      expect(res.status).toBe(404);
    });
  },
);
