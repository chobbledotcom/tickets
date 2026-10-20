import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import processedScanOperations from "#db/migrations/2026-10-20_processed_scan_operations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => processedScanOperations(buildMigrationContext());

describeWithEnv(
  "db > migrations > processed scan operations",
  { db: true },
  () => {
    test("declares the table it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-10-20_processed_scan_operations");
      expect(migration().requires).toEqual({
        indexes: [],
        newTables: ["processed_scan_operations"],
      });
    });
  },
);
