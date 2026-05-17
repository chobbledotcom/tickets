// deno-lint-ignore-file no-explicit-any
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import {
  getAllBuiltSites,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import {
  adminFormPost,
  createTestBuiltSite,
  createTestEvent,
  describeWithEnv,
  expectRedirectWithFlash,
  provisionTestBuiltSite,
  testCookie,
} from "#test-utils";
import { mockRequest } from "#test-utils/mocks.ts";

const NOW_MS = 1_700_000_000_000;

const findSite = async (
  siteId: number,
): Promise<import("#shared/db/built-sites.ts").BuiltSite> =>
  (await getAllBuiltSites()).find((s) => s.id === siteId)!;

type SecretStub = any;

describeWithEnv("admin built-sites actions", { db: true }, () => {
  let secretStub: SecretStub;

  beforeEach(() => {
    secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ ok: true as const }),
    );
  });

  afterEach(() => {
    if (!secretStub.restored) secretStub.restore();
  });

  describe("POST /admin/built-sites/:id/rotate-renewal-token", () => {
    test("rotates token on a provisioned site and pushes new RENEWAL_URL", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6001",
        name: "Rotate Site",
      });
      const { token: oldToken } = await provisionTestBuiltSite(site.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/rotate-renewal-token`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Renewal token rotated",
      )(response);

      const updated = await findSite(site.id);
      expect(updated.renewalToken).not.toBe(oldToken);
      expect(updated.renewalToken).not.toBeNull();
      expect(updated.renewalTokenIndex).not.toBeNull();

      // Rotate only re-pushes RENEWAL_URL, not READ_ONLY_FROM.
      const secretNames = (secretStub.calls as any[]).map(
        (c: any) => c.args[1] as string,
      );
      expect(secretNames).toContain("RENEWAL_URL");
      expect(secretNames).not.toContain("READ_ONLY_FROM");

      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message.includes("Rotated renewal token")),
      ).toBe(true);
    });

    test("redirects on unprovisioned site (no-op)", async () => {
      const site = await createTestBuiltSite({ name: "Unprovisioned Rotate" });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/rotate-renewal-token`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Renewal is not provisioned for this site",
        false,
      )(response);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  describe("POST /admin/built-sites/:id/bump-deadline", () => {
    test("bumps from current deadline on future-dated site", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6010",
          name: "Bump Future",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS + 10 * 86400000).toISOString(),
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "3",
        });

        const updated = await findSite(site.id);
        const expectedBase = new Date(NOW_MS + 10 * 86400000).toISOString();
        expect(updated.readOnlyFrom).toBe(addMonthsIso(expectedBase, 3));
      } finally {
        fakeTime.restore();
      }
    });

    test("bumps from now on expired site", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6011",
          name: "Bump Expired",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS - 30 * 86400000).toISOString(),
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "6",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 6);
        expect(updated.readOnlyFrom).toBe(expected);
      } finally {
        fakeTime.restore();
      }
    });

    test("bumps from now on deadline-less site", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6012",
          name: "Bump No Deadline",
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "2",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 2);
        expect(updated.readOnlyFrom).toBe(expected);
      } finally {
        fakeTime.restore();
      }
    });

    test("works without a renewal token (no RENEWAL_URL push)", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6013",
        name: "Bump No Token",
      });
      secretStub.restore();
      secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/bump-deadline`,
        { months: "1" },
      );
      expect(response.status).toBe(302);

      const secretNames = (secretStub.calls as any[]).map(
        (c: any) => c.args[1] as string,
      );
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("clamps months <= 0 to 1", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6014",
          name: "Bump Zero",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "0" },
        );
        expect(response.status).toBe(302);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe(
          addMonthsIso(new Date(NOW_MS).toISOString(), 1),
        );
      } finally {
        fakeTime.restore();
      }
    });

    test("clamps months > 120 to 120", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6015",
          name: "Bump Large",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "999" },
        );
        expect(response.status).toBe(302);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe(
          addMonthsIso(new Date(NOW_MS).toISOString(), 120),
        );
      } finally {
        fakeTime.restore();
      }
    });

    test("returns error when CDN push fails", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6016",
        name: "Bump CDN Fail",
      });
      secretStub.restore();
      const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "edge push failed", ok: false as const }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "1" },
        );
        expectRedirectWithFlash(
          `/admin/built-sites/${site.id}/edit`,
          expect.stringContaining("could not be pushed"),
          false,
        )(response);
      } finally {
        failStub.restore();
      }
    });

    test("clamps non-numeric months to 1", async () => {
      const fakeTime = new FakeTime(NOW_MS);
      try {
        const site = await createTestBuiltSite({
          bunnyScriptId: "6017",
          name: "Bump NaN",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "abc" },
        );
        expect(response.status).toBe(302);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe(
          addMonthsIso(new Date(NOW_MS).toISOString(), 1),
        );
      } finally {
        fakeTime.restore();
      }
    });
  });

  describe("POST /admin/built-sites/:id/override-deadline", () => {
    test("accepts a future date and pushes it", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6020",
        name: "Override Site",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/override-deadline`,
        { date: "2027-06-15" },
      );
      expect(response.status).toBe(302);

      const updated = await findSite(site.id);
      expect(updated.readOnlyFrom).toBe("2027-06-15T23:59:59Z");
    });

    test("works without a renewal token", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6021",
        name: "Override No Token",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/override-deadline`,
        { date: "2027-12-01" },
      );
      expect(response.status).toBe(302);

      const secretNames = (secretStub.calls as any[]).map(
        (c: any) => c.args[1] as string,
      );
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("redirects when date is missing", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6022",
        name: "Override Empty",
      });
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/override-deadline`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Choose a deadline date",
        false,
      )(response);

      const updated = await findSite(site.id);
      expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    });
  });

  describe("POST /admin/built-sites/:id/re-sync-deadline", () => {
    test("re-pushes stored deadline and RENEWAL_URL when provisioned", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6030",
        name: "Resync Site",
      });
      await provisionTestBuiltSite(site.id);
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-03-15T00:00:00Z",
      });

      secretStub.restore();
      secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/re-sync-deadline`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Deadline re-synced",
      )(response);

      const secretNames = (secretStub.calls as any[]).map(
        (c: any) => c.args[1] as string,
      );
      expect(secretNames).toContain("READ_ONLY_FROM");
      expect(secretNames).toContain("RENEWAL_URL");
    });

    test("re-pushes deadline without RENEWAL_URL when unprovisioned", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6031",
        name: "Resync Unprovisioned",
      });
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-04-01T00:00:00Z",
      });

      secretStub.restore();
      secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/re-sync-deadline`,
      );
      expect(response.status).toBe(302);

      const secretNames = (secretStub.calls as any[]).map(
        (c: any) => c.args[1] as string,
      );
      expect(secretNames).toContain("READ_ONLY_FROM");
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("redirects when deadline is empty", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6032",
        name: "Resync Empty",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/re-sync-deadline`,
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "No deadline to re-sync",
        false,
      )(response);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  describe("POST /admin/built-sites/:id/provision-renewal", () => {
    test("provisions an unprovisioned site with token and deadline (no tier id stored)", async () => {
      // A qualifying tier must exist so the customer has something to pick at /renew.
      await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6040",
        name: "Provision Site",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-renewal`,
        { months: "3" },
      );
      expect(response.status).toBe(302);

      const updated = await findSite(site.id);
      expect(updated.renewalTokenIndex).not.toBeNull();
      expect(updated.renewalToken).not.toBeNull();
      expect(updated.readOnlyFrom).not.toBe("");

      const renewResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(updated.renewalToken!)}`),
      );
      expect(renewResponse.status).toBe(200);
    });

    test("rejects when no qualifying tier event exists", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6041",
        name: "No Tier Provision",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-renewal`,
        { months: "3" },
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Create a qualifying renewal tier event before provisioning",
        false,
      )(response);

      const updated = await findSite(site.id);
      expect(updated.renewalTokenIndex).toBeNull();
    });

    test("redirects on already provisioned site", async () => {
      await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6042",
        name: "Already Provisioned",
      });
      await provisionTestBuiltSite(site.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-renewal`,
        { months: "3" },
      );
      expectRedirectWithFlash(
        `/admin/built-sites/${site.id}/edit`,
        "Renewal is already provisioned for this site",
        false,
      )(response);
    });

    test("Bunny failure: token persists but read_only_from stays empty", async () => {
      await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6043",
        name: "Provision Fail",
      });

      secretStub.restore();
      const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "edge push failed", ok: false as const }),
      );

      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3" },
        );
        expectRedirectWithFlash(
          `/admin/built-sites/${site.id}/edit`,
          "Renewal was saved, but the deadline could not be pushed to the site",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalTokenIndex).not.toBeNull();
        expect(updated.readOnlyFrom).toBe("");
      } finally {
        failStub.restore();
      }
    });
  });

  describe("CSRF validation", () => {
    test("POST without CSRF token returns 403", async () => {
      const site = await createTestBuiltSite({ name: "CSRF Test Site" });
      const cookie = await testCookie();
      const response = await handleRequest(
        new Request(
          `http://localhost/admin/built-sites/${site.id}/bump-deadline`,
          {
            body: new URLSearchParams({ months: "1" }).toString(),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie,
            },
            method: "POST",
          },
        ),
      );
      expect(response.status).toBe(403);
    });
  });
});
