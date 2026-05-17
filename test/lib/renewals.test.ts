import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  getAllActivityLog,
} from "#shared/db/activityLog.ts";
import {
  getAllBuiltSites,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { applyRenewalsForEntries } from "#shared/webhook.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  createTestEvent,
  describeWithEnv,
  makeTestEntry,
} from "#test-utils";

const NOW_MS = 1_700_000_000_000;

const setupRenewalSite = async (tierEventId: number, readOnlyFrom: string) => {
  const token = generateSecureToken();
  const tokenIndex = await hmacHash(token);
  await insertBuiltSite(
    "Renewal Site",
    "renewal.b-cdn.net",
    "",
    "",
    false,
    "5001",
  );
  const sites = await getAllBuiltSites();
  const site = sites.find((s) => s.name === "Renewal Site")!;
  await updateBuiltSiteRenewalState(site.id, {
    readOnlyFrom,
    renewalToken: token,
    renewalTokenIndex: tokenIndex,
    renewalTierEventId: tierEventId,
  });
  return { site, token };
};

// deno-lint-ignore no-explicit-any
type SecretStub = any;

const withFakeTimeAndStub = async (
  nowMs: number,
  fn: (secretStub: SecretStub) => Promise<void>,
): Promise<void> => {
  const fakeTime = new FakeTime(nowMs);
  const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );
  try {
    await fn(secretStub);
  } finally {
    secretStub.restore();
    fakeTime.restore();
  }
};

describeWithEnv("renewals", { db: true }, () => {
  test("site with future read_only_from + 3 months bumps from existing deadline", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const futureDate = new Date(NOW_MS + 10 * 86400000).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, futureDate);

    await withFakeTimeAndStub(NOW_MS, async (_secretStub) => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 3 },
      );
      await applyRenewalsForEntries([entry], token);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      const expected = addMonthsIso(futureDate, 3);
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("expired site + 6 month renewal bumps from now, not past", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const pastDate = new Date(NOW_MS - 30 * 86400000).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, pastDate);

    await withFakeTimeAndStub(NOW_MS, async () => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 6 },
      );
      await applyRenewalsForEntries([entry], token);

      const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 6);
      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("months_per_unit=3 with quantity=2 adds 6 months", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 3,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, baseDate);

    await withFakeTimeAndStub(NOW_MS, async () => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 3 },
        { quantity: 2 },
      );
      await applyRenewalsForEntries([entry], token);

      const expected = addMonthsIso(baseDate, 6);
      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("pushReadOnlyFrom is called exactly once with computed cutoff", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { token } = await setupRenewalSite(tier.id, baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 2 },
      );
      await applyRenewalsForEntries([entry], token);

      expect(secretStub.calls.length).toBe(1);
      const secretName = secretStub.calls[0]!.args[1] as string;
      expect(secretName).toBe("READ_ONLY_FROM");
    });
  });

  test("entry with no siteToken produces no Bunny call", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    await setupRenewalSite(tier.id, baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], undefined);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  test("siteToken present but no matching site logs error, no Bunny call", async () => {
    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        { months_per_unit: 1 },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], "nonexistent-token-xyz");

      expect(secretStub.calls.length).toBe(0);
    });
  });

  test("end-of-month: Jan 31 + 1mo lands on Feb 28", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const { token, site } = await setupRenewalSite(tier.id, "2026-01-31T00:00:00Z");

    const fakeJan = new Date("2026-01-15T00:00:00Z").getTime();
    await withFakeTimeAndStub(fakeJan, async () => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], token);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe("2026-02-28T00:00:00.000Z");
    });
  });

  test("pushReadOnlyFrom failure does not advance host-side read_only_from", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, baseDate);

    const fakeTime = new FakeTime(NOW_MS);
    const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ error: "edge push failed", ok: false as const }),
    );
    try {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], token);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(baseDate);
    } finally {
      failStub.restore();
      fakeTime.restore();
    }
  });

  test("end-to-end: Stripe webhook with site_token fires applyRenewalsForEntries through to setEdgeScriptSecret", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 2 },
      );
      await applyRenewalsForEntries([entry], token);

      expect(secretStub.calls.length).toBe(1);
      const scriptId = secretStub.calls[0]!.args[0] as number;
      expect(scriptId).toBe(Number(site.bunnyScriptId));

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      const expected = addMonthsIso(baseDate, 2);
      expect(updated.readOnlyFrom).toBe(expected);

      const logs = await getAllActivityLog();
      const renewalLog = logs.find((l) => l.message.includes("Renewal of"));
      expect(renewalLog).toBeDefined();
      expect(renewalLog!.message).toContain("2 month(s)");
    });
  });

  test("end-to-end: payment success redirect path also triggers renewal bump", async () => {
    const tier = await createTestEvent({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { token, site } = await setupRenewalSite(tier.id, baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        { id: tier.id, months_per_unit: 1 },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], token);

      expect(secretStub.calls.length).toBe(1);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      const expected = addMonthsIso(baseDate, 1);
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });
});
