/**
 * Renewing a built site from a completed order: how many months it buys, which
 * listing the log records it against, and what is said when the renewal cannot
 * be applied.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type Stub, spy, stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import type { BuiltSiteRow } from "#db/built-sites/types.ts";
import {
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { applyRenewalsForEntries } from "#shared/webhook.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import type { EmailEntry } from "#test-utils/internal.ts";

/** A renewal tier line: hidden, purchase-only, and worth months per unit. */
const tierEntry = (
  listingId: number,
  monthsPerUnit: number,
  quantity: number,
): EmailEntry =>
  makeEntry(
    {
      active: true,
      hidden: true,
      id: listingId,
      months_per_unit: monthsPerUnit,
      purchase_only: true,
      unit_price: 100,
    },
    { quantity },
  );

/** A built site with a renewal token, and that token's one-way code. */
const siteWithToken = async (
  name: string,
  token: string,
): Promise<{ site: BuiltSiteRow; tokenIndex: string }> => {
  const site = await insertBuiltSite(
    name,
    `${token}.test.net`,
    "",
    "",
    true,
    "3001",
  );
  const tokenIndex = await hmacHash(token);
  await updateBuiltSiteRenewalState(site.id, {
    readOnlyFrom: "2099-01-01T00:00:00Z",
    renewalToken: token,
    renewalTokenIndex: tokenIndex,
  });
  return { site, tokenIndex };
};

/** What one renewal attempt produced: the error log, and every alert body the
 * ntfy endpoint was pinged with. */
type RenewalOutcome = { logged: string; alerts: string[] };

/** Run the renewal with the secret push succeeding or failing, collecting the
 * error log and any operator alert sent. */
const renewWithPush = async (
  entries: EmailEntry[],
  tokenIndex: string | undefined,
  pushSucceeds: boolean,
): Promise<RenewalOutcome> => {
  const secretStub: Stub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve(
      pushSucceeds
        ? { ok: true as const }
        : { error: "provider refused", ok: false as const },
    ),
  );
  const alerts: string[] = [];
  const fetchStub = stubFetch((_url, init) => {
    alerts.push(String(init?.body ?? ""));
    return new Response("ok");
  });
  const errorSpy = spy(console, "error");
  try {
    await applyRenewalsForEntries(entries, tokenIndex);
  } finally {
    errorSpy.restore();
    fetchStub.restore();
    secretStub.restore();
  }
  return {
    alerts,
    logged: errorSpy.calls.map((call) => String(call.args[0])).join("\n"),
  };
};

/** The newest renewal line in the activity log. */
const renewalLogEntry = async (): Promise<
  { message: string; listing_id: number | null } | undefined
> =>
  (await getAllActivityLog()).find((entry) =>
    entry.message.startsWith("Renewal of"),
  );

describeWithEnv(
  "built-site renewals from an order",
  { db: true, env: { NTFY_URL: "https://ntfy.example.com/alerts" } },
  () => {
    test("buys a month for every unit of every renewal line", async () => {
      const { tokenIndex } = await siteWithToken(
        "Renew Months",
        "months-token",
      );

      await renewWithPush(
        [tierEntry(101, 3, 2), tierEntry(102, 1, 1)],
        tokenIndex,
        true,
      );

      expect((await renewalLogEntry())?.message).toContain("for 7 month(s)");
    });

    test("counts a single-month line too", async () => {
      const { tokenIndex } = await siteWithToken("Renew One", "one-token");

      await renewWithPush([tierEntry(103, 1, 1)], tokenIndex, true);

      expect((await renewalLogEntry())?.message).toContain("for 1 month(s)");
    });

    test("records the renewal against the first renewal line's listing", async () => {
      const { tokenIndex } = await siteWithToken("Renew First", "first-token");

      await renewWithPush(
        [tierEntry(111, 1, 1), tierEntry(222, 1, 1)],
        tokenIndex,
        true,
      );

      expect((await renewalLogEntry())?.listing_id).toBe(111);
    });

    test("refuses an order whose listing is not a renewal tier", async () => {
      const { tokenIndex } = await siteWithToken("Renew Wrong", "wrong-token");
      const notATier = makeEntry(
        {
          active: true,
          hidden: false,
          id: 55,
          months_per_unit: 0,
          purchase_only: false,
          unit_price: 100,
        },
        { quantity: 1 },
      );

      const { logged } = await renewWithPush([notATier], tokenIndex, true);
      expect(logged).toContain(
        "Renewal rejected: listing 55 is not an active hidden purchase-only renewal tier",
      );
      expect(await renewalLogEntry()).toBeUndefined();
    });

    test("names the unknown token by its first eight characters only", async () => {
      const unknownIndex = "abcdefghijklmnop";

      const { logged } = await renewWithPush(
        [tierEntry(104, 1, 1)],
        unknownIndex,
        true,
      );
      expect(logged).toContain(
        "Renewal site not found for token index abcdefgh...",
      );
    });

    test("says so when the deadline cannot be pushed to the site", async () => {
      const { tokenIndex } = await siteWithToken("Renew Fail", "fail-token");

      const { alerts, logged } = await renewWithPush(
        [tierEntry(105, 1, 1)],
        tokenIndex,
        false,
      );
      expect(logged).toContain("CDN_REQUEST");
      // The operator alert names the failing area, so a push failure is
      // distinguishable from any other alert the site sends.
      expect(alerts).toContain("CDN_REQUEST");
      expect(logged).toContain(
        "Failed to push READ_ONLY_FROM for renewal of 'Renew Fail': provider refused",
      );
      expect(await renewalLogEntry()).toBeUndefined();
    });

    test("ignores a line that is not a renewal tier at all", async () => {
      const { tokenIndex } = await siteWithToken("Renew Skip", "skip-token");
      const notATier = makeEntry(
        {
          active: true,
          hidden: false,
          months_per_unit: 0,
          purchase_only: false,
          unit_price: 100,
        },
        { quantity: 1 },
      );

      await renewWithPush([notATier], tokenIndex, true);

      expect(await renewalLogEntry()).toBeUndefined();
    });

    test("does nothing at all without a renewal token", async () => {
      await siteWithToken("Renew None", "none-token");

      const { logged } = await renewWithPush(
        [tierEntry(106, 1, 1)],
        undefined,
        true,
      );
      expect(logged).toBe("");
      expect(await renewalLogEntry()).toBeUndefined();
    });
  },
);
