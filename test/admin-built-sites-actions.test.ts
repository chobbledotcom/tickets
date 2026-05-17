// deno-lint-ignore-file no-explicit-any
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { addMonthsIso } from "#shared/dates.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  getAllActivityLog,
} from "#shared/db/activityLog.ts";
import {
  getAllBuiltSites,
  getBuiltSiteRenewalToken,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import {
  adminFormPost,
  createTestBuiltSite,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";
import { handleRequest } from "#routes";
import { mockRequest } from "#test-utils/mocks.ts";

const NOW_MS = 1_700_000_000_000;

const provisionSite = async (siteId: number, tierEventId: number) => {
  const { generateRenewalToken } = await import("#shared/site-assignment.ts");
  const { index, token } = await generateRenewalToken();
  await updateBuiltSiteRenewalState(siteId, {
    renewalToken: token,
    renewalTokenIndex: index,
    renewalTierEventId: tierEventId,
  });
  return token;
};

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
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6001",
        name: "Rotate Site",
      });
      const oldToken = await provisionSite(site.id, tier.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/rotate-renewal-token`,
      );
      expect(response.status).toBe(302);

      const newToken = await getBuiltSiteRenewalToken(
        (await getAllBuiltSites()).find((s) => s.id === site.id)!,
      );
      expect(newToken).not.toBe(oldToken);

      const restartedSite = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
      expect(restartedSite.renewalTokenIndex).not.toBeNull();

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message.includes("Rotated renewal token"))).toBe(true);
    });

    test("redirects on unprovisioned site (no-op)", async () => {
      const site = await createTestBuiltSite({ name: "Unprovisioned Rotate" });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/rotate-renewal-token`,
      );
      expect(response.status).toBe(302);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  describe("POST /admin/built-sites/:id/set-renewal-tier", () => {
    test("updates tier on a provisioned site", async () => {
      const tier1 = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const tier2 = await createTestEvent({
        hidden: true,
        monthsPerUnit: 3,
        purchaseOnly: true,
        unitPrice: 1200,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6002",
        name: "Set Tier Site",
      });
      await provisionSite(site.id, tier1.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/set-renewal-tier`,
        { tier_event_id: String(tier2.id) },
      );
      expect(response.status).toBe(302);

      const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
      expect(updated.renewalTierEventId).toBe(tier2.id);
    });

    test("rejects non-qualifying tier event id", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6003",
        name: "Bad Tier Site",
      });
      await provisionSite(site.id, tier.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/set-renewal-tier`,
        { tier_event_id: "99999" },
      );
      expect(response.status).toBe(302);

      const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
      expect(updated.renewalTierEventId).toBe(tier.id);
    });

    test("redirects on unprovisioned site", async () => {
      const site = await createTestBuiltSite({ name: "Unprovisioned Tier" });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/set-renewal-tier`,
        { tier_event_id: "1" },
      );
      expect(response.status).toBe(302);
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

        await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "3" },
        );

        const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
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

        await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "6" },
        );

        const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
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

        await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "2" },
        );

        const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
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

      const secretNames = (secretStub.calls as any[]).map((c: any) => c.args[1] as string);
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("clamps months <= 0 to 1", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6014",
        name: "Bump Zero",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/bump-deadline`,
        { months: "0" },
      );
      expect(response.status).toBe(302);

      const logs = await getAllActivityLog();
      const bumpLog = logs.find((l) => l.message.includes("bumped") && l.message.includes("1 month"));
      expect(bumpLog).toBeDefined();
    });

    test("clamps months > 120 to 120", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6015",
        name: "Bump Large",
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/bump-deadline`,
        { months: "999" },
      );
      expect(response.status).toBe(302);

      const logs = await getAllActivityLog();
      const bumpLog = logs.find((l) => l.message.includes("120 month"));
      expect(bumpLog).toBeDefined();
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

      const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
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

      const secretNames = (secretStub.calls as any[]).map((c: any) => c.args[1] as string);
      expect(secretNames).not.toContain("RENEWAL_URL");
    });

    test("redirects when date is missing", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "6022",
        name: "Override Empty",
      });
      await updateBuiltSiteRenewalState(site.id, { readOnlyFrom: "2027-01-01T00:00:00Z" });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/override-deadline`,
      );
      expect(response.status).toBe(302);

      const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    });
  });

  describe("POST /admin/built-sites/:id/re-sync-deadline", () => {
    test("re-pushes stored deadline and RENEWAL_URL when provisioned", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6030",
        name: "Resync Site",
      });
      await provisionSite(site.id, tier.id);
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
      expect(response.status).toBe(302);

      const secretNames = (secretStub.calls as any[]).map((c: any) => c.args[1] as string);
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

      const secretNames = (secretStub.calls as any[]).map((c: any) => c.args[1] as string);
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
      expect(response.status).toBe(302);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  describe("POST /admin/built-sites/:id/provision-renewal", () => {
    test("provisions an unprovisioned site with token, tier, and deadline", async () => {
      const tier = await createTestEvent({
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
        { months: "3", tier_event_id: String(tier.id) },
      );
      expect(response.status).toBe(302);

      const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
      expect(updated.renewalTierEventId).toBe(tier.id);
      expect(updated.renewalTokenIndex).not.toBeNull();
      expect(updated.readOnlyFrom).not.toBe("");

      const token = await getBuiltSiteRenewalToken(updated);
      expect(token).not.toBeNull();

      const renewResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token!)}`),
      );
      expect(renewResponse.status).toBe(200);
    });

    test("redirects on already provisioned site", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6041",
        name: "Already Provisioned",
      });
      await provisionSite(site.id, tier.id);

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-renewal`,
        { months: "3", tier_event_id: String(tier.id) },
      );
      expect(response.status).toBe(302);
    });

    test("Bunny failure: token + tier persist but read_only_from stays empty", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const site = await createTestBuiltSite({
        bunnyScriptId: "6042",
        name: "Provision Fail",
      });

      secretStub.restore();
      const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "edge push failed", ok: false as const }),
      );

      try {
        await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3", tier_event_id: String(tier.id) },
        );

        const updated = (await getAllBuiltSites()).find((s) => s.id === site.id)!;
        expect(updated.renewalTierEventId).toBe(tier.id);
        expect(updated.renewalTokenIndex).not.toBeNull();
        expect(updated.readOnlyFrom).toBe("");
      } finally {
        failStub.restore();
      }
    });
  });
});
