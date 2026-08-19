import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { inPlaceholders, withTransaction } from "#db/client.ts";
import { TransactionValidationError, txIdSet } from "#db/transaction.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

test("transaction validation errors keep their diagnostic name", () => {
  expect(new TransactionValidationError("No longer valid").name).toBe(
    "TransactionValidationError",
  );
});

describeWithEnv("transaction ID sets", { db: true }, () => {
  test("returns the unique IDs that still exist", async () => {
    const listing = await createTestListing({ name: "Transaction ID set" });

    const ids = await withTransaction((tx) =>
      txIdSet(tx, [listing.id, listing.id, 999_999], (unique) => ({
        args: unique,
        sql: `SELECT id FROM listings WHERE id IN (${inPlaceholders(unique)})`,
      })),
    );

    expect(ids).toEqual(new Set([listing.id]));
  });

  test("skips the lookup for an empty input", async () => {
    const ids = await withTransaction((tx) =>
      txIdSet(tx, [], () => {
        throw new Error("An empty ID set must not build a query");
      }),
    );

    expect(ids).toEqual(new Set());
  });
});
