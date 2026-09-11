import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import {
  backfillListingPrices,
  syncListingPrices,
  syncListingPricesForIds,
} from "#db/listing-price-sync.ts";
import {
  expectBackfillRebuildsBaseRows,
  priceRows,
} from "#test/shared/db/listing-prices/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("listing base-mirror sync", { db: true }, () => {
  test("admin create/edit keep the base row synced from unit_price", async () => {
    // The real admin form path writes base from the unit_price column mirror.
    const listing = await createTestListing({ unitPrice: 750 });
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 750 },
    ]);
    await updateTestListing(listing.id, { unitPrice: 900 });
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 900 },
    ]);
  });

  test("backfill rebuilds the base rows from unit_price", async () => {
    await expectBackfillRebuildsBaseRows(() => backfillListingPrices());
  });

  test("a source row whose price is not a number fails the backfill loudly", async () => {
    // SQLite stores whatever survives the column's affinity: a price that
    // reached the column as text is a drifted shape the read must refuse, not
    // pass through to the base row as-is.
    const listing = await createTestListing({ unitPrice: 750 });
    await queryAll("UPDATE listings SET unit_price = 'free' WHERE id = ?", [
      listing.id,
    ]);
    await expect(backfillListingPrices()).rejects.toThrow("Invalid type");
  });

  test("syncListingPricesForIds rebuilds base rows for the given listings only", async () => {
    const a = await createTestListing({ unitPrice: 300 });
    const b = await createTestListing({ unitPrice: 700 });
    await queryAll("DELETE FROM listing_prices WHERE price_type = 'base'");
    await syncListingPricesForIds([a.id, b.id]);
    expect(await priceRows(a.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 300 },
    ]);
    expect(await priceRows(b.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 700 },
    ]);
  });

  test("syncListingPricesForIds rebuilds a single listing, and only it", async () => {
    const only = await createTestListing({ unitPrice: 450 });
    const untouched = await createTestListing({ unitPrice: 800 });
    // The other listing's mirror is left deliberately stale. Syncing one id
    // must not quietly refresh it — that is what proves the scope is honoured
    // rather than the whole table being rebuilt.
    await queryAll("DELETE FROM listing_prices WHERE listing_id = ?", [
      only.id,
    ]);
    await queryAll(
      "UPDATE listing_prices SET unit_price = 1 WHERE listing_id = ?",
      [untouched.id],
    );

    await syncListingPricesForIds([only.id]);

    expect(await priceRows(only.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 450 },
    ]);
    expect(await priceRows(untouched.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 1 },
    ]);
  });

  test("syncListingPricesForIds is a no-op for an empty id list", async () => {
    await syncListingPricesForIds([]);
    expect(await priceRows(987656)).toEqual([]);
  });

  test("the bulk sync maps a NULL column to zero", async () => {
    const listing = await createTestListing({ unitPrice: 640 });
    await queryAll("UPDATE listings SET unit_price = NULL WHERE id = ?", [
      listing.id,
    ]);

    await syncListingPricesForIds([listing.id]);

    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 0 },
    ]);
  });

  test("syncListingPrices is a no-op for a listing that does not exist", async () => {
    await syncListingPrices(987654);
    expect(await priceRows(987654)).toEqual([]);
  });

  test("a source row that is not a number fails the sync loudly", async () => {
    const listing = await createTestListing({ unitPrice: 750 });
    await queryAll("UPDATE listings SET unit_price = 'free' WHERE id = ?", [
      listing.id,
    ]);
    await expect(syncListingPrices(listing.id)).rejects.toThrow("Invalid type");
    // The loud failure must leave the valid mirror standing. The writes are
    // guarded by the same numeric check the parse enforces, so a drifted
    // column fails loudly without committing the drifted value first.
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 750 },
    ]);
  });

  test("syncListingPrices mirrors the column in one database call", async () => {
    // One batch does the whole job: the source rows are read, the guarded
    // delete and insert run beside them, and the parse above validates the
    // read — a single database round trip.
    const listing = await createTestListing({ unitPrice: 640 });
    await queryAll(
      "UPDATE listing_prices SET unit_price = 1 WHERE listing_id = ? AND price_type = 'base'",
      [listing.id],
    );

    expect(
      await countDatabaseCalls(1, () => syncListingPrices(listing.id)),
    ).toBe(1);
    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 640 },
    ]);
  });

  test("a page of listings syncs in one batch per page", async () => {
    // The guarded delete and insert for each listing ride one batch with the
    // source read, however many listings the page holds.
    const listings: { id: number; unit_price: number }[] = [];
    for (const unitPrice of [500, 501, 502]) {
      listings.push(await createTestListing({ unitPrice }));
    }

    expect(
      await countDatabaseCalls(1, () =>
        syncListingPricesForIds(listings.map((listing) => listing.id)),
      ),
    ).toBe(1);
    for (const listing of listings) {
      expect(await priceRows(listing.id)).toEqual([
        { price_id: "", price_type: "base", unit_price: listing.unit_price },
      ]);
    }
  });

  test("syncListingPrices maps a NULL column to zero", async () => {
    const listing = await createTestListing({ unitPrice: 640 });
    await queryAll("UPDATE listings SET unit_price = NULL WHERE id = ?", [
      listing.id,
    ]);

    await syncListingPrices(listing.id);

    expect(await priceRows(listing.id)).toEqual([
      { price_id: "", price_type: "base", unit_price: 0 },
    ]);
  });
});
