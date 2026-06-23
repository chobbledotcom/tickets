import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { getAllBuiltSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import { applyRenewalsForEntries } from "#shared/webhook.ts";
import {
  createTestListing,
  describeWithEnv,
  getAllActivityLog,
  makeTestEntry,
  provisionTestBuiltSite,
} from "#test-utils";

const NOW_MS = 1_700_000_000_000;

const setupRenewalSite = async (readOnlyFrom: string) => {
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
  // applyRenewalsForEntries takes the HMAC index (the same value that's stored
  // in Stripe metadata after the boundary hashing); the plain token is unused
  // in these tests.
  const { tokenIndex } = await provisionTestBuiltSite(site.id, {
    readOnlyFrom,
  });
  return { site, tokenIndex };
};

const makeRenewalEntry = (
  listing: { id: number; months_per_unit: number },
  quantity: number,
) =>
  makeTestEntry(
    {
      active: true,
      hidden: true,
      id: listing.id,
      months_per_unit: listing.months_per_unit,
      purchase_only: true,
    },
    { quantity },
  );

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
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const futureDate = new Date(NOW_MS + 10 * 86400000).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(futureDate);

    await withFakeTimeAndStub(NOW_MS, async (_secretStub) => {
      const entry = makeRenewalEntry(tier, 3);
      await applyRenewalsForEntries([entry], tokenIndex);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      const expected = addMonthsIso(futureDate, 3);
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("expired site + 6 month renewal bumps from now, not past", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const pastDate = new Date(NOW_MS - 30 * 86400000).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(pastDate);

    await withFakeTimeAndStub(NOW_MS, async () => {
      const entry = makeRenewalEntry(tier, 6);
      await applyRenewalsForEntries([entry], tokenIndex);

      const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 6);
      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("months_per_unit=3 with quantity=2 adds 6 months", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 3,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(baseDate);

    await withFakeTimeAndStub(NOW_MS, async () => {
      const entry = makeRenewalEntry(tier, 2);
      await applyRenewalsForEntries([entry], tokenIndex);

      const expected = addMonthsIso(baseDate, 6);
      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(expected);
    });
  });

  test("pushReadOnlyFrom is called exactly once with computed cutoff", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { tokenIndex } = await setupRenewalSite(baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeRenewalEntry(tier, 2);
      await applyRenewalsForEntries([entry], tokenIndex);

      expect(secretStub.calls.length).toBe(1);
      const secretName = secretStub.calls[0]!.args[1] as string;
      expect(secretName).toBe("READ_ONLY_FROM");
    });
  });

  test("entry with no siteToken produces no Bunny call", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    await setupRenewalSite(baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeRenewalEntry(tier, 1);
      await applyRenewalsForEntries([entry], undefined);

      expect(secretStub.calls.length).toBe(0);
    });
  });

  test("siteToken present but no matching site logs error, no Bunny call", async () => {
    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeRenewalEntry({ id: 1, months_per_unit: 1 }, 1);
      await applyRenewalsForEntries([entry], "nonexistent-token-xyz");

      expect(secretStub.calls.length).toBe(0);
    });
  });

  test("siteToken present with a non-renewal listing does not bump deadline", async () => {
    const baseDate = new Date(NOW_MS).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeTestEntry(
        {
          active: true,
          hidden: false,
          months_per_unit: 12,
          purchase_only: true,
          unit_price: 500,
        },
        { quantity: 1 },
      );
      await applyRenewalsForEntries([entry], tokenIndex);

      expect(secretStub.calls.length).toBe(0);
      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(baseDate);
    });
  });

  test("end-of-month: Jan 31 + 1mo lands on Feb 28", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const { tokenIndex, site } = await setupRenewalSite("2026-01-31T00:00:00Z");

    const fakeJan = new Date("2026-01-15T00:00:00Z").getTime();
    await withFakeTimeAndStub(fakeJan, async () => {
      const entry = makeRenewalEntry(tier, 1);
      await applyRenewalsForEntries([entry], tokenIndex);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe("2026-02-28T00:00:00.000Z");
    });
  });

  test("pushReadOnlyFrom failure does not advance host-side read_only_from", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(baseDate);

    const fakeTime = new FakeTime(NOW_MS);
    const failStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ error: "edge push failed", ok: false as const }),
    );
    try {
      const entry = makeRenewalEntry(tier, 1);
      await applyRenewalsForEntries([entry], tokenIndex);

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(baseDate);
    } finally {
      failStub.restore();
      fakeTime.restore();
    }
  });

  test("applyRenewalsForEntries pushes READ_ONLY_FROM, logs activity, persists cutoff", async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const baseDate = new Date(NOW_MS).toISOString();
    const { tokenIndex, site } = await setupRenewalSite(baseDate);

    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeRenewalEntry(tier, 2);
      await applyRenewalsForEntries([entry], tokenIndex);

      expect(secretStub.calls.length).toBe(1);
      const [scriptId, secretName, secretValue] = secretStub.calls[0]!.args as [
        number,
        string,
        string,
      ];
      expect(scriptId).toBe(Number(site.bunnyScriptId));
      expect(secretName).toBe("READ_ONLY_FROM");
      expect(secretValue).toBe(addMonthsIso(baseDate, 2));

      const sites = await getAllBuiltSites();
      const updated = sites.find((s) => s.id === site.id)!;
      expect(updated.readOnlyFrom).toBe(addMonthsIso(baseDate, 2));

      const logs = await getAllActivityLog();
      const renewalLog = logs.find((l) => l.message.includes("Renewal of"));
      expect(renewalLog).toBeDefined();
      expect(renewalLog!.message).toContain("2 month(s)");
    });
  });
});
