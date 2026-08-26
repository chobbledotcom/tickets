import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
  updateTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

const findSite = async (siteId: number): Promise<BuiltSite> =>
  (await builtSites.getAll()).find((site) => site.id === siteId)!;

const createTier = (name: string, months: number, price: number) =>
  createTestListing({
    hidden: true,
    monthsPerUnit: months,
    name,
    purchaseOnly: true,
    unitPrice: price,
  });

const setTier = (siteId: number, tierId: string) =>
  adminFormPost(`/admin/built-sites/${siteId}/set-renewal-tier`, {
    tier_id: tierId,
  });

/** A site already set to renew on a fresh monthly tier — where every change
 * below starts. */
const siteOnTier = async (name: string) => {
  const tier = await createTier("Monthly tier", 1, 500);
  const site = await createTestBuiltSite({ name });
  await setTier(site.id, String(tier.id));
  return { site, tier };
};

/** What clearing looks like: the flash the operator reads, and no tier stored. */
const expectClearedTier = async (
  siteId: number,
  response: Response,
): Promise<void> => {
  await expectFlashRedirect(
    `/admin/built-sites/${siteId}/renewal`,
    "Renewal tier cleared. The customer now picks any tier.",
  )(response);
  expect((await findSite(siteId)).renewalTierListingId).toBeNull();
};

describeWithEnv(
  "admin built-sites renewal tier",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    describe("POST /admin/built-sites/:id/set-renewal-tier", () => {
      test("stores the chosen tier and records who changed it", async () => {
        const tier = await createTier("Annual tier", 12, 5000);
        const site = await createTestBuiltSite({ name: "Tier Site" });

        const { response } = await setTier(site.id, String(tier.id));

        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "This site now renews on Annual tier.",
        )(response);
        expect((await findSite(site.id)).renewalTierListingId).toBe(tier.id);
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin set 'Tier Site' to renew on 'Annual tier'");
      });

      test("clears the tier so the customer picks any of them", async () => {
        const { site } = await siteOnTier("Cleared Site");

        const { response } = await setTier(site.id, "");

        await expectClearedTier(site.id, response);
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin cleared the renewal tier for 'Cleared Site'");
      });

      test("refuses a listing that is not a renewal tier", async () => {
        const { site, tier } = await siteOnTier("Refusing Site");
        const ordinary = await createTestListing({ name: "Ordinary listing" });

        const { response } = await setTier(site.id, String(ordinary.id));

        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Pick a renewal tier from the list.",
          false,
        )(response);
        expect((await findSite(site.id)).renewalTierListingId).toBe(tier.id);
      });

      test("clears a retired tier after every tier listing has gone", async () => {
        const { site, tier } = await siteOnTier("Retired Tier Site");
        await deactivateTestListing(tier.id);

        const { response } = await setTier(site.id, "");

        await expectClearedTier(site.id, response);
      });

      test("refuses a listing id that does not exist", async () => {
        const site = await createTestBuiltSite({ name: "Missing Tier Site" });

        const { response } = await setTier(site.id, "999999");

        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Pick a renewal tier from the list.",
          false,
        )(response);
        expect((await findSite(site.id)).renewalTierListingId).toBeNull();
      });

      test("survives an ordinary edit of the site's own fields", async () => {
        const { site, tier } = await siteOnTier("Edited Site");

        await updateTestBuiltSite(site.id, { name: "Renamed Site" });

        const updated = await findSite(site.id);
        expect(updated.name).toBe("Renamed Site");
        expect(updated.renewalTierListingId).toBe(tier.id);
      });

      test("keeps the site's other renewal state untouched", async () => {
        const tier = await createTier("Monthly tier", 1, 500);
        const site = await createTestBuiltSite({ name: "Untouched Site" });
        const { token } = await provisionTestBuiltSite(site.id, {
          readOnlyFrom: "2027-01-15T00:00:00Z",
        });

        await setTier(site.id, String(tier.id));

        const updated = await findSite(site.id);
        expect(updated.renewalTierListingId).toBe(tier.id);
        expect(updated.renewalToken).toBe(token);
        expect(updated.readOnlyFrom).toBe("2027-01-15T00:00:00Z");
      });
    });
  },
);
