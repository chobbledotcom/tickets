import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { CatalogBundle } from "#routes/admin/catalog-transfer/schema.ts";
import { requireBundleImport } from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The mixed package with its stored member re-added at quantity 1, beside
 * the second member the caller declares. */
const mixedWithStoredMember = async (
  second: CatalogBundle["groups"][number]["members"][number],
): Promise<CatalogBundle> => {
  await createTestListing({ maxQuantity: 5, name: "Stored Member" });
  const bundle = mixedPackage();
  bundle.groups[0]!.members = [
    { listing: "Stored Member", quantity: 1 },
    second,
  ];
  return bundle;
};

/** A package group whose members mix a stored row and a planned listing. */
const mixedPackage = (): CatalogBundle => ({
  groups: [
    {
      group: { isPackage: true, name: "Mixed Pack" },
      members: [
        { listing: "Stored Member", quantity: 4 },
        { listing: "Planned Member" },
      ],
    },
  ],
  kind: "bundle",
  listings: [
    {
      groups: [],
      listing: {
        maxAttendees: 5,
        maxPrice: 0,
        name: "Planned Member",
        unitPrice: 500,
      },
      parents: [],
    },
  ],
  version: 1,
});

describeWithEnv("bundle package member checks", { db: true }, () => {
  test("judges a stored member against its stored quantities", async () => {
    await createTestListing({ maxQuantity: 1, name: "Stored Member" });
    const result = await importCatalog(mixedPackage());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, '"Mixed Pack"');
    assertStringIncludes(result.error, "Stored Member");
  });

  test("judges a planned member against its own input fields", async () => {
    // The planned member's own input carries no 2-day price, so the override
    // the group declares for it is refused.
    const bundle = await mixedWithStoredMember({
      dayPrices: { "2": 300 },
      listing: "Planned Member",
    });
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      '"Planned Member" does not offer a 2-day booking',
    );
  });

  test("refuses a mixed package whose members disagree on customisable days", async () => {
    await createTestListing({
      customisableDays: true,
      dayPrices: { "1": 600 },
      durationDays: 1,
      maxQuantity: 5,
      name: "Stored Member",
    });
    const result = await importCatalog(mixedPackage());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      'All listings in a group must agree on customisable days, but "Stored Member" and "Planned Member" differ.',
    );
  });

  test("refuses a stored member that assigns a built site", async () => {
    const member = await createTestListing({
      maxQuantity: 5,
      name: "Stored Member",
    });
    // The create form carries no built-site switch; the column is the fact.
    await execute("UPDATE listings SET assign_built_site = 1 WHERE id = ?", [
      member.id,
    ]);
    const result = await importCatalog(mixedPackage());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("Stored Member");
    expect(result.error).toContain("Mixed Pack");
  });

  test("reports a member the site and document do not hold", async () => {
    await createTestListing({ maxQuantity: 5, name: "Stored Member" });
    const bundle = mixedPackage();
    bundle.groups[0]!.members = [
      { listing: "Stored Member", quantity: 1 },
      { listing: "Ghost Member" },
    ];
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain(
      'No listing named "Ghost Member" exists — it must already exist to import this reference.',
    );
  });

  test("imports the mixed package when every rule passes", async () => {
    const bundle = await mixedWithStoredMember({
      listing: "Planned Member",
      quantity: 1,
    });
    const result = await importCatalog(bundle);
    expect(requireBundleImport(result).groups).toBe(1);
  });
});
