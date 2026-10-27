import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import {
  freshSlugs,
  requireRowsTx,
} from "#routes/admin/catalog-transfer/bundle.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("bundle write guards", { db: true }, () => {
  test("freshSlugs returns one slug per row when the site holds none", async () => {
    const fresh = await freshSlugs(3);
    expect(fresh).toHaveLength(3);
    expect(new Set(fresh.map((entry) => entry.slugIndex)).size).toBe(3);
  });

  test("freshSlugs gives up after ten attempts when every slug is taken", async () => {
    let attempts = 0;
    await expect(
      freshSlugs(2, (slugIndexes) => {
        attempts += 1;
        return Promise.resolve(new Set(slugIndexes));
      }),
    ).rejects.toThrow("Failed to generate unique slugs");
    expect(attempts).toBe(10);
  });

  test("requireRowsTx passes for existing rows and throws for a vanished one", async () => {
    const stored = await createTestListing({ name: "Guarded" });
    const storedId = stored.id;
    await withTransaction(async (tx) => {
      await requireRowsTx(
        tx,
        "listings",
        [storedId],
        "catalog_transfer.member_missing",
      );
      await expect(
        requireRowsTx(
          tx,
          "listings",
          [storedId, 999999999],
          "catalog_transfer.member_missing",
        ),
      ).rejects.toThrow("no longer exists");
      // No ids: nothing to check.
      await requireRowsTx(
        tx,
        "listings",
        [],
        "catalog_transfer.member_missing",
      );
    });
  });
});
