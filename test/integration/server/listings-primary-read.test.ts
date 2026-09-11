import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { createDatabaseClient } from "#db/database-client.ts";
import { isReadSql } from "#db/sql-text.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";
import { adminMultipartPost } from "#test-utils/session.ts";

describeWithEnv("listing save primary read", { db: true }, () => {
  test("saves the first two listings when separate read batches miss their committed rows", async () => {
    const database = getDb();
    const batch = database.batch.bind(database);
    const remote = hranaTestFetch((sql, args, primary) =>
      primary
        ? database.execute({ args, sql })
        : Promise.resolve(emptyResultSet()),
    );
    const reader = createDatabaseClient({
      fetch: remote.fetch,
      url: "libsql://pipeline.test",
    });
    // Mirror the client's own routing rule: a complete SELECT-only write-mode
    // batch is the one shape real libSQL can offload to a replica, so those
    // run through the stale-replica reader. Mixed and pure-write batches stay
    // on the write path — the server routes them to the primary itself.
    using _batch = stub(database, "batch", (statements, mode) => {
      const offloadable =
        mode === "write" &&
        statements.length > 0 &&
        statements.every(
          (statement) =>
            typeof statement === "object" &&
            !Array.isArray(statement) &&
            isReadSql(statement.sql),
        );
      return offloadable
        ? reader.batch(statements, mode)
        : batch(statements, mode);
    });
    try {
      for (const name of ["First listing", "Second listing"]) {
        const { response } = await adminMultipartPost("/admin/listing", {
          max_attendees: "50",
          max_quantity: "1",
          name,
          unit_price: "12.00",
        });
        await expectFlashRedirect("/admin", "Listing created")(response);
      }
      const rows = await database.execute(
        "SELECT listing.id, listingPrice.unit_price FROM listings AS listing JOIN listing_prices AS listingPrice ON listingPrice.listing_id = listing.id WHERE listingPrice.price_type = 'base' ORDER BY listing.id",
      );
      expect(rows.rows.map((row) => [row.id, row.unit_price])).toEqual([
        [1, 1200],
        [2, 1200],
      ]);
      expect(remote.requests).toHaveLength(2);
      for (const request of remote.requests) {
        expect(request).toEqual([
          "BEGIN IMMEDIATE",
          "batch",
          "COMMIT",
          "close",
        ]);
      }
    } finally {
      reader.close();
    }
  });
});
