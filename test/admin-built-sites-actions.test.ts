// deno-lint-ignore-file no-explicit-any
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  getAllBuiltSites,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { expectedSiteSecrets } from "#shared/site-secrets.ts";
import {
  adminFormPost,
  createTestBuiltSite,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  getAllActivityLog,
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

/** The secret names (`args[1]`) recorded by a setEdgeScriptSecret stub. */
const secretNamesOf = (s: { calls: any[] }): string[] =>
  (s.calls as any[]).map((c: any) => c.args[1] as string);

/** POST a built-site action form (`/admin/built-sites/:id/<action>`). */
const siteAction = (
  site: { id: number },
  action: string,
  data?: Record<string, string>,
) => adminFormPost(`/admin/built-sites/${site.id}/${action}`, data);

/** Assert bump-deadline clamps `months` to `expectedMonths` (under fake time). */
const expectBumpClamps = async (
  scriptId: string,
  siteName: string,
  months: string,
  expectedMonths: number,
): Promise<void> => {
  const fakeTime = new FakeTime(NOW_MS);
  try {
    const site = await createTestBuiltSite({
      bunnyScriptId: scriptId,
      name: siteName,
    });
    const { response } = await siteAction(site, "bump-deadline", { months });
    expect(response.status).toBe(302);
    const updated = await findSite(site.id);
    expect(updated.readOnlyFrom).toBe(
      addMonthsIso(new Date(NOW_MS).toISOString(), expectedMonths),
    );
  } finally {
    fakeTime.restore();
  }
};

describeWithEnv("admin built-sites actions", { db: true }, () => {
  let secretStub: SecretStub;

  const installSecretStub = () =>
    stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ ok: true as const }),
    );

  /** Restore and re-install the secret stub (clears its recorded calls). */
  const resetSecretStub = () => {
    secretStub.restore();
    secretStub = installSecretStub();
  };

  beforeEach(() => {
    secretStub = installSecretStub();
  });

  afterEach(() => {
    if (!secretStub.restored) secretStub.restore();
  });

  /** Run `body` with the secret stub swapped for one that fails every push. */
  const withFailingSecretStub = async (body: () => Promise<void>) => {
    secretStub.restore();
    const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ error: "edge push failed", ok: false as const }),
    );
    try {
      await body();
    } finally {
      failStub.restore();
    }
  };

  /** Assert override-deadline rejects `date` without changing state or pushing. */
  const expectOverrideRejected = async (
    scriptId: string,
    siteName: string,
    date: string,
  ): Promise<void> => {
    const site = await createTestBuiltSite({
      bunnyScriptId: scriptId,
      name: siteName,
    });
    await updateBuiltSiteRenewalState(site.id, {
      readOnlyFrom: "2027-01-01T00:00:00Z",
    });
    const { response } = await siteAction(site, "override-deadline", { date });
    await expectFlashRedirect(
      `/admin/built-sites/${site.id}/edit`,
      "Choose a valid deadline date",
      false,
    )(response);
    const updated = await findSite(site.id);
    expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    expect(secretStub.calls.length).toBe(0);
  };

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
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/edit`,
        "Renewal token rotated",
      )(response);

      const updated = await findSite(site.id);
      expect(updated.renewalToken).not.toBe(oldToken);
      expect(updated.renewalToken).not.toBeNull();
      expect(updated.renewalTokenIndex).not.toBeNull();

      // Rotate only re-pushes RENEWAL_URL, not READ_ONLY_FROM.
      const secretNames = secretNamesOf(secretStub);
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
      await expectFlashRedirect(
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
      resetSecretStub();

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/bump-deadline`,
        { months: "1" },
      );
      expect(response.status).toBe(302);

      const secretNames = secretNamesOf(secretStub);
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("clamps months <= 0 to 1", () =>
      expectBumpClamps("6014", "Bump Zero", "0", 1));

    test("clamps months > 120 to 120", () =>
      expectBumpClamps("6015", "Bump Large", "999", 120));

    test("returns error when CDN push fails", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6016",
        name: "Bump CDN Fail",
      });
      await withFailingSecretStub(async () => {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "1" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          expect.stringContaining("could not be pushed"),
          false,
        )(response);
      });
    });

    test("clamps non-numeric months to 1", () =>
      expectBumpClamps("6017", "Bump NaN", "abc", 1));
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

      const secretNames = secretNamesOf(secretStub);
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
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/edit`,
        "Choose a deadline date",
        false,
      )(response);

      const updated = await findSite(site.id);
      expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    });

    test("rejects an invalid date without pushing", () =>
      expectOverrideRejected("6023", "Override Invalid", "2027-02-31"));

    test("rejects a non-date-format string without pushing", () =>
      expectOverrideRejected("6024", "Override Not Date", "hello"));
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

      resetSecretStub();

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/re-sync-deadline`,
      );
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/edit`,
        "Deadline re-synced",
      )(response);

      const secretNames = secretNamesOf(secretStub);
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

      resetSecretStub();

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/re-sync-deadline`,
      );
      expect(response.status).toBe(302);

      const secretNames = secretNamesOf(secretStub);
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
      await expectFlashRedirect(
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
      await createTestListing({
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

    test("rejects when no qualifying tier listing exists", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6041",
        name: "No Tier Provision",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-renewal`,
        { months: "3" },
      );
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/edit`,
        "Create a qualifying renewal tier listing before provisioning",
        false,
      )(response);

      const updated = await findSite(site.id);
      expect(updated.renewalTokenIndex).toBeNull();
    });

    test("redirects on already provisioned site", async () => {
      await createTestListing({
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
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/edit`,
        "Renewal is already provisioned for this site",
        false,
      )(response);
    });

    test("Bunny failure leaves renewal state unprovisioned", async () => {
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6043",
        name: "Provision Fail",
      });

      await withFailingSecretStub(async () => {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          "Renewal could not be pushed to the site",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalTokenIndex).toBeNull();
        expect(updated.readOnlyFrom).toBe("");
      });
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

describeWithEnv(
  "admin built-sites add-secrets",
  {
    db: true,
    env: { BUNNY_API_KEY: "k", NTFY_URL: "https://ntfy.example.com/t" },
  },
  () => {
    /** Stub the live secret list + a recording setEdgeScriptSecret. */
    const stubSecrets = (present: string[]) => {
      const setCalls: { name: string; value: string }[] = [];
      const listStub = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
        Promise.resolve({
          ok: true as const,
          secrets: present.map((Name) => ({
            Id: 1,
            LastModified: "2026-01-01T00:00:00Z",
            Name,
          })),
        }),
      );
      const setStub = stub(
        bunnyCdnApi,
        "setEdgeScriptSecret",
        (_id: number, name: string, value: string) => {
          setCalls.push({ name, value });
          return Promise.resolve({ ok: true as const });
        },
      );
      return {
        restore: () => {
          listStub.restore();
          setStub.restore();
        },
        setCalls,
      };
    };

    test("backfills secrets missing from the live list and logs the change", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "7100",
        dbToken: "tok",
        dbUrl: "libsql://u",
        name: "Backfill Site",
      });
      const secrets = stubSecrets([]); // nothing live yet — everything is missing
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          expect.stringContaining("missing secret(s)"),
        )(response);

        const setNames = secrets.setCalls.map((c) => c.name);
        expect(setNames).toContain("NTFY_URL");
        expect(setNames).toContain("DB_URL");
        // The unreproducible encryption key is never set.
        expect(setNames).not.toContain("DB_ENCRYPTION_KEY");

        const logs = await getAllActivityLog();
        expect(logs.some((l) => l.message.includes("missing secret"))).toBe(
          true,
        );
      } finally {
        secrets.restore();
      }
    });

    test("never overwrites a secret that already exists on the site", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "7101",
        dbToken: "tok",
        dbUrl: "libsql://u",
        name: "No Overwrite Site",
      });
      // Live list already has everything expected except NTFY_URL.
      const present = expectedSiteSecrets(site)
        .map(([name]) => name)
        .filter((name) => name !== "NTFY_URL");
      const secrets = stubSecrets(present);
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          "Set 1 missing secret(s): NTFY_URL",
        )(response);
        // Only the genuinely-missing secret is written.
        expect(secrets.setCalls.map((c) => c.name)).toEqual(["NTFY_URL"]);
      } finally {
        secrets.restore();
      }
    });

    test("reports nothing to do when every expected secret is present", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "7102",
        dbToken: "tok",
        dbUrl: "libsql://u",
        name: "All Present Site",
      });
      const present = expectedSiteSecrets(site).map(([name]) => name);
      const secrets = stubSecrets(present);
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          "No missing secrets — nothing to set",
        )(response);
        expect(secrets.setCalls.length).toBe(0);
      } finally {
        secrets.restore();
      }
    });

    test("surfaces an error when a secret cannot be set", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "7103",
        name: "Push Fail Site",
      });
      const listStub = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
        Promise.resolve({ ok: true as const, secrets: [] }),
      );
      const setStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "edge push failed", ok: false as const }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/edit`,
          expect.stringContaining("Secrets could not be set"),
          false,
        )(response);
      } finally {
        listStub.restore();
        setStub.restore();
      }
    });

    test("returns 404 for a non-existent built site", async () => {
      const { response } = await adminFormPost(
        "/admin/built-sites/999999/add-secrets",
      );
      expect(response.status).toBe(404);
    });
  },
);
