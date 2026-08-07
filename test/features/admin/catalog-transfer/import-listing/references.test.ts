import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { execute } from "#shared/db/client.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const expectImportError = async (
  blob: unknown,
  message: string,
): Promise<void> => {
  const result = await importCatalog(blob);
  expect(result).toEqual({ error: message, ok: false });
};

describeWithEnv("catalog import references", { db: true }, () => {
  test("reports a missing parent as a listing reference", async () => {
    await expectImportError(
      {
        kind: "listing",
        listing: { maxAttendees: 1, name: "Missing-parent child" },
        parents: ["Absent parent"],
        version: 1,
      },
      'No listing named "Absent parent" exists — it must already exist to import this reference.',
    );
  });

  test("reports a missing listing in a group import", async () => {
    await expectImportError(
      {
        group: { name: "Missing-member group" },
        kind: "group",
        members: [{ listing: "Absent member" }],
        version: 1,
      },
      'No listing named "Absent member" exists — it must already exist to import this reference.',
    );
  });

  test("reports a missing group as a group reference", async () => {
    await expectImportError(
      {
        groups: [{ group: "Absent group" }],
        kind: "listing",
        listing: { maxAttendees: 1, name: "Missing-group joiner" },
        version: 1,
      },
      'No group named "Absent group" exists — it must already exist to import this reference.',
    );
  });

  test("rejects a child that joins a package", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Child package",
    });
    const parent = await createTestListing({ name: "Package parent" });

    await expectImportError(
      {
        groups: [{ group: group.name }],
        kind: "listing",
        listing: { maxAttendees: 1, name: "Package child" },
        parents: [parent.name],
        version: 1,
      },
      '"Package child" is a member of the package "Child package", so it cannot also be an add-on child of another listing.',
    );
  });

  test("rejects a parent that is already a child", async () => {
    const grandparent = await createTestListing({ name: "Top listing" });
    const parent = await createTestListing({ name: "Nested listing" });
    await listingChildren.setIds(grandparent.id, [parent.id]);

    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Third level" },
      parents: [parent.name],
      version: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe(
      `'${parent.name}' is itself offered as a child of another listing, so it can't also be a parent.`,
    );
  });

  test("does not treat a visible ordinary-group member as a hidden-package parent", async () => {
    const group = await createTestGroup({ name: "Visible ordinary group" });
    await execute("UPDATE groups SET hide_package_listings = 1 WHERE id = ?", [
      group.id,
    ]);
    groups.cache.invalidate();
    const parent = await createTestListing({ name: "Visible parent" });
    await assignListingsToGroup([parent.id], group.id);

    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Allowed child" },
      parents: [parent.name],
      version: 1,
    });

    expect(result.ok).toBe(true);
  });
});
