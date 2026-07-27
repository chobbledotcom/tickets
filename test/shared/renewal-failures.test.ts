import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { builtSites } from "#shared/db/built-sites.ts";
import type { RenewalDelivery } from "#shared/payment-completion-delivery.ts";
import { applyPaidRenewal } from "#shared/renewal.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupRenewalSite } from "#test-utils/db-helpers/built-sites.ts";

const READ_ONLY_FROM = "2026-09-01T00:00:00.000Z";

/** What the site looked like when the buyer paid, ready to be spoilt one
 *  field at a time. */
const renewalDelivery = async (
  changes: Partial<RenewalDelivery> = {},
): Promise<RenewalDelivery> => {
  const { site, tokenIndex } = await setupRenewalSite(READ_ONLY_FROM);
  return {
    hostingId: site.hostingId,
    hostingProvider: site.hostingProvider,
    kind: "renewal",
    listingId: 8,
    months: 2,
    previousReadOnlyFrom: READ_ONLY_FROM,
    readOnlyFrom: "2026-11-01T00:00:00.000Z",
    renewalTokenIndex: tokenIndex,
    siteId: site.id,
    siteName: site.name,
    ...changes,
  };
};

describeWithEnv(
  "a paid renewal that no longer fits its site",
  { db: true },
  () => {
    test("refuses when the site has been removed since the payment", async () => {
      const delivery = await renewalDelivery();
      await builtSites.table.deleteById(delivery.siteId);
      builtSites.invalidate();

      await expect(applyPaidRenewal(delivery)).rejects.toThrow(
        `Renewal site ${delivery.siteId} was removed`,
      );
    });

    test("refuses when the site is no longer the one that was paid for", async () => {
      const delivery = await renewalDelivery({ hostingId: "someone-else" });

      await expect(applyPaidRenewal(delivery)).rejects.toThrow(
        "Renewal site facts changed after payment",
      );
    });

    test("refuses when the deadline moved between paying and renewing", async () => {
      // Someone else already pushed this site's date out, so adding these months
      // on top would give away more than was bought.
      const delivery = await renewalDelivery({
        previousReadOnlyFrom: "2026-08-01T00:00:00.000Z",
      });

      await expect(applyPaidRenewal(delivery)).rejects.toThrow(
        "Renewal deadline changed after payment",
      );
    });

    test("reports a renewal the host would not accept", async () => {
      const delivery = await renewalDelivery();
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "no route to host", ok: false as const }),
      );

      await expect(applyPaidRenewal(delivery)).rejects.toThrow(
        "Paid renewal failed: no route to host",
      );
    });

    test("refuses when the site goes while the renewal is being pushed", async () => {
      const delivery = await renewalDelivery();
      using _secrets = stub(bunnyCdnApi, "setEdgeScriptSecret", async () => {
        await builtSites.table.deleteById(delivery.siteId);
        builtSites.invalidate();
        return { ok: true as const };
      });

      await expect(applyPaidRenewal(delivery)).rejects.toThrow(
        `Renewal site ${delivery.siteId} was removed`,
      );
    });
  },
);
