import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import type { ImportedBundle } from "#routes/admin/catalog-transfer/bundle-plan.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { ImportedEntity } from "#routes/admin/catalog-transfer/import-listing.ts";
import type { Result } from "#shared/result.ts";
import {
  requireEntityImport,
  storedListingIdOf,
} from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// One listing imports as a bundle of one: the same validation phases, the
// same write, the same guards an array of listings runs. These tests pin the
// parity — same stored result, same refusals — and the one place the shapes
// legitimately differ: the result (one entity versus created counts).

const listingBody = (name: string) => ({
  listing: { maxAttendees: 3, name },
});

/** Import the same listing body through both shapes: first as the single
 *  blob, then as a bundle document holding one item. Refusal parity needs the
 *  same name in both; success parity mints a second name. */
const importBothShapes = async (
  soloName: string,
  bundledName: string,
  body: Partial<Parameters<typeof importCatalog>[0] & object> = {},
): Promise<
  [
    Result<ImportedEntity | ImportedBundle>,
    Result<ImportedEntity | ImportedBundle>,
  ]
> => {
  const solo = await importCatalog({
    ...listingBody(soloName),
    ...body,
    kind: "listing",
    version: 1,
  });
  const bundled = await importCatalog({
    kind: "bundle",
    listings: [{ ...listingBody(bundledName), ...body }],
    version: 1,
  });
  return [solo, bundled];
};

/** Both shapes refuse, and the bundle's attributed report carries the very
 *  reason the single blob answers with. */
const expectSameRefusal = (
  solo: Result<ImportedEntity | ImportedBundle>,
  bundled: Result<ImportedEntity | ImportedBundle>,
  fragment: string,
): void => {
  expect(solo.ok).toBe(false);
  expect(bundled.ok).toBe(false);
  if (solo.ok || bundled.ok) throw new Error("unreachable");
  expect(bundled.error).toContain(solo.error);
  expect(solo.error).toContain(fragment);
};

describeWithEnv("single import equals a bundle of one", { db: true }, () => {
  test("stores the same listing columns through either shape", async () => {
    const [solo, bundled] = await importBothShapes(
      "Parity Solo",
      "Parity Bundled",
    );

    const soloImport = requireEntityImport(solo);
    expect(soloImport).toMatchObject({
      kind: "listing",
      name: "Parity Solo",
    });
    expect(bundled).toEqual({
      ok: true,
      value: { groups: 0, kind: "bundle", listings: 1 },
    });
    if (!bundled.ok) throw new Error("unreachable");

    const storedSolo = await getListingWithCount(soloImport.id);
    const storedBundled = await getListingWithCount(
      await storedListingIdOf("Parity Solo"),
    );
    if (!storedSolo || !storedBundled) {
      throw new Error("The imported listing is missing");
    }
    // Slugs are minted per row and `created` is the import moment; every
    // transferable column must match.
    const comparable = (stored: typeof storedSolo) => {
      const {
        created,
        id,
        name,
        slug,
        slug_index: slugIndex,
        ...rest
      } = stored;
      return rest;
    };
    expect(comparable(storedSolo)).toEqual(comparable(storedBundled));
  });

  test("refuses a taken name with the same reason through either shape", async () => {
    await createTestListing({ name: "Parity Taken" });
    const [solo, bundled] = await importBothShapes(
      "Parity Taken",
      "Parity Taken",
    );
    expectSameRefusal(solo, bundled, "Parity Taken");
  });

  test("refuses a missing parent reference with the same reason through either shape", async () => {
    const [solo, bundled] = await importBothShapes(
      "Parity Orphan Solo",
      "Parity Orphan Bundled",
      { parents: ["Parity Missing Parent"] },
    );
    expectSameRefusal(solo, bundled, "Parity Missing Parent");
  });

  test("stores the same group membership through either shape", async () => {
    const member = await createTestListing({ name: "Parity Group Member" });
    const solo = await importCatalog({
      group: { name: "Parity Solo Group" },
      kind: "group",
      members: [{ listing: member.name }],
      version: 1,
    });
    const bundled = await importCatalog({
      groups: [
        {
          group: { name: "Parity Bundled Group" },
          members: [{ listing: member.name }],
        },
      ],
      kind: "bundle",
      version: 1,
    });

    const soloImport = requireEntityImport(solo);
    expect(soloImport).toMatchObject({
      kind: "group",
      name: "Parity Solo Group",
    });
    expect(bundled).toEqual({
      ok: true,
      value: { groups: 1, kind: "bundle", listings: 0 },
    });
    if (!bundled.ok) throw new Error("unreachable");
  });
});
