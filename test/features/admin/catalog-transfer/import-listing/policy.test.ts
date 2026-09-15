import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllListings } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { featureSetting } from "#test-utils/settings.ts";

const importPolicyListing = async (
  name: string,
  adminLevel?: "editor" | "owner",
) => {
  const result = await importCatalog(
    {
      kind: "listing",
      listing: {
        maxAttendees: 5,
        name,
        useDefaults: true,
        usesLogistics: true,
        webhookUrl: "https://hooks.example.test/orders",
      },
      version: 1,
    },
    adminLevel,
  );
  if (!result.ok) throw new Error(result.error);
  const listing = (await getAllListings()).find((row) => row.name === name);
  if (!listing) throw new Error("imported listing not found");
  return listing;
};

/** Whether a listing named `name` exists — the "nothing partially imported"
 *  probe for refused imports. */
const hasStoredListing = async (name: string): Promise<boolean> =>
  (await getAllListings()).some((row) => row.name === name);

describeWithEnv("catalog import policy", { db: true }, () => {
  test("an editor cannot import protected listing settings", async () => {
    const listing = await importPolicyListing("Editor policy", "editor");

    expect(listing.webhook_url).toBe("");
    expect(listing.use_defaults).toBe(false);
  });

  test("an owner keeps protected listing settings", async () => {
    const listing = await importPolicyListing("Owner policy", "owner");

    expect(listing.webhook_url).toBe("https://hooks.example.test/orders");
    expect(listing.use_defaults).toBe(true);
  });

  test("logistics stays off when the feature is unavailable", async () => {
    expect((await importPolicyListing("No logistics")).uses_logistics).toBe(
      false,
    );
  });

  test("logistics remains required when the feature is enabled", async () => {
    settings.setForTest(featureSetting("logistics"));
    expect((await importPolicyListing("With logistics")).uses_logistics).toBe(
      true,
    );
  });

  test("refuses a listing import that assigns a built site", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: {
        assignBuiltSite: true,
        initialSiteMonths: 12,
        maxAttendees: 5,
        name: "Refused Plan",
      },
      version: 1,
    });

    expect(result).toEqual({
      error: t("catalog_transfer.site_plan_listing_refused", {
        name: "Refused Plan",
      }),
      ok: false,
    });
    expect(await hasStoredListing("Refused Plan")).toBe(false);
  });

  test("refuses a built-site plan import even with the builder configured", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });

    expect(
      await importCatalog({
        kind: "listing",
        listing: {
          assignBuiltSite: true,
          maxAttendees: 5,
          name: "Builder Plan",
        },
        version: 1,
      }),
    ).toEqual({
      error: t("catalog_transfer.site_plan_listing_refused", {
        name: "Builder Plan",
      }),
      ok: false,
    });
  });
});
