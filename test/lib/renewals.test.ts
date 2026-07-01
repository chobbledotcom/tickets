import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  type BuiltSite,
  getAllBuiltSites,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import type { Listing } from "#shared/types.ts";
import { applyRenewalsForEntries } from "#shared/webhook.ts";
import {
  createTestListing,
  describeWithEnv,
  getAllActivityLog,
  makeTestEntry,
  provisionTestBuiltSite,
} from "#test-utils";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

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

type StubResult = { ok: true } | { ok: false; error: string };

const withFakeTimeAndStub = async (
  nowMs: number,
  fn: (secretStub: SecretStub) => Promise<void>,
  stubResult: StubResult = { ok: true as const },
): Promise<void> => {
  using _fakeTime = new FakeTime(nowMs);
  const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve(stubResult),
  );
  try {
    await fn(secretStub);
  } finally {
    secretStub.restore();
  }
};

const expectReadOnlyFrom = async (
  site: BuiltSite,
  expected: string,
): Promise<void> => {
  const sites = await getAllBuiltSites();
  const updated = sites.find((s) => s.id === site.id)!;
  expect(updated.readOnlyFrom).toBe(expected);
};

const expectNoBunnyCall = (secretStub: SecretStub): void => {
  expect(secretStub.calls.length).toBe(0);
};

const expectReadOnlyFromPush = (
  secretStub: SecretStub,
): { scriptId: number; secretValue: string } => {
  expect(secretStub.calls.length).toBe(1);
  const [scriptId, secretName, secretValue] = secretStub.calls[0]!.args as [
    number,
    string,
    string,
  ];
  expect(secretName).toBe("READ_ONLY_FROM");
  return { scriptId, secretValue };
};

type RenewalCtx = {
  baseDate: string;
  secretStub: SecretStub;
  site: BuiltSite;
  tier: Listing;
  tokenIndex: string;
};

const withRenewalTest =
  (
    opts: {
      monthsPerUnit?: number;
      nowMs?: number;
      quantity: number;
      readOnlyFrom?: string;
      siteTokenIndex?: string | "none";
      stubResult?: StubResult;
      unitPrice?: number;
    },
    fn: (ctx: RenewalCtx) => Promise<void>,
  ): (() => Promise<void>) =>
  async () => {
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: opts.monthsPerUnit ?? 1,
      purchaseOnly: true,
      unitPrice: opts.unitPrice ?? 500,
    });
    const baseDate = opts.readOnlyFrom ?? NOW_ISO;
    const { tokenIndex, site } = await setupRenewalSite(baseDate);
    const siteTokenIndex =
      opts.siteTokenIndex === "none"
        ? undefined
        : (opts.siteTokenIndex ?? tokenIndex);
    await withFakeTimeAndStub(
      opts.nowMs ?? NOW_MS,
      async (secretStub) => {
        const entry = makeRenewalEntry(tier, opts.quantity);
        await applyRenewalsForEntries([entry], siteTokenIndex);
        await fn({ baseDate, secretStub, site, tier, tokenIndex });
      },
      opts.stubResult ?? { ok: true as const },
    );
  };

describeWithEnv("renewals", { db: true }, () => {
  test(
    "site with future read_only_from + 3 months bumps from existing deadline",
    withRenewalTest(
      {
        quantity: 3,
        readOnlyFrom: new Date(NOW_MS + 10 * 86400000).toISOString(),
      },
      async ({ baseDate, site }) => {
        await expectReadOnlyFrom(site, addMonthsIso(baseDate, 3));
      },
    ),
  );

  test(
    "expired site + 6 month renewal bumps from now, not past",
    withRenewalTest(
      {
        quantity: 6,
        readOnlyFrom: new Date(NOW_MS - 30 * 86400000).toISOString(),
      },
      async ({ site }) => {
        await expectReadOnlyFrom(site, addMonthsIso(NOW_ISO, 6));
      },
    ),
  );

  test(
    "months_per_unit=3 with quantity=2 adds 6 months",
    withRenewalTest(
      { monthsPerUnit: 3, quantity: 2 },
      async ({ baseDate, site }) => {
        await expectReadOnlyFrom(site, addMonthsIso(baseDate, 6));
      },
    ),
  );

  test(
    "pushReadOnlyFrom is called exactly once with computed cutoff",
    withRenewalTest({ quantity: 2 }, async ({ secretStub }) => {
      expectReadOnlyFromPush(secretStub);
    }),
  );

  test(
    "entry with no siteToken produces no Bunny call",
    withRenewalTest(
      { quantity: 1, siteTokenIndex: "none" },
      async ({ secretStub }) => {
        expectNoBunnyCall(secretStub);
      },
    ),
  );

  test("siteToken present but no matching site logs error, no Bunny call", async () => {
    await withFakeTimeAndStub(NOW_MS, async (secretStub) => {
      const entry = makeRenewalEntry({ id: 1, months_per_unit: 1 }, 1);
      await applyRenewalsForEntries([entry], "nonexistent-token-xyz");
      expectNoBunnyCall(secretStub);
    });
  });

  test("siteToken present with a non-renewal listing does not bump deadline", async () => {
    const { tokenIndex, site } = await setupRenewalSite(NOW_ISO);

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
      expectNoBunnyCall(secretStub);
      await expectReadOnlyFrom(site, NOW_ISO);
    });
  });

  test(
    "end-of-month: Jan 31 + 1mo lands on Feb 28",
    withRenewalTest(
      {
        nowMs: new Date("2026-01-15T00:00:00Z").getTime(),
        quantity: 1,
        readOnlyFrom: "2026-01-31T00:00:00Z",
      },
      async ({ site }) => {
        await expectReadOnlyFrom(site, "2026-02-28T00:00:00.000Z");
      },
    ),
  );

  test(
    "pushReadOnlyFrom failure does not advance host-side read_only_from",
    withRenewalTest(
      {
        quantity: 1,
        stubResult: { error: "edge push failed", ok: false as const },
      },
      async ({ baseDate, site }) => {
        await expectReadOnlyFrom(site, baseDate);
      },
    ),
  );

  test(
    "applyRenewalsForEntries pushes READ_ONLY_FROM, logs activity, persists cutoff",
    withRenewalTest({ quantity: 2 }, async ({ baseDate, secretStub, site }) => {
      const { scriptId, secretValue } = expectReadOnlyFromPush(secretStub);
      expect(scriptId).toBe(Number(site.hostingId));
      expect(secretValue).toBe(addMonthsIso(baseDate, 2));
      await expectReadOnlyFrom(site, addMonthsIso(baseDate, 2));

      const logs = await getAllActivityLog();
      const renewalLog = logs.find((l) => l.message.includes("Renewal of"));
      expect(renewalLog).toBeDefined();
      expect(renewalLog!.message).toContain("2 month(s)");
    }),
  );
});
