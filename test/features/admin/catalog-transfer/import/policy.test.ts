import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { featureSetting } from "#test-utils/settings.ts";

const importPolicyListing = async (
  name: string,
  adminLevel?: "editor" | "owner",
) => {
  const result = await importCatalog(
    {
      kind: "listing",
      listing: {
        assignBuiltSite: true,
        initialSiteMonths: 12,
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
  const listing = await getListingWithCount(result.value.id);
  if (!listing) throw new Error("imported listing not found");
  return listing;
};

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

  test("builder fields are cleared when site building is unavailable", async () => {
    const listing = await importPolicyListing("No builder");

    expect(listing.assign_built_site).toBe(false);
    expect(listing.initial_site_months).toBe(0);
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
});
