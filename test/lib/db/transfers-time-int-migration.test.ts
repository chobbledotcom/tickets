import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { postTransfers } from "#shared/accounting/store.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const migration = MIGRATIONS.find(
  (m) => m.id === "2026-06-22_transfers_time_int",
)!;

describe("db > migrations > transfers time INTEGER", () => {
  useTransactionalDb();

  test("refuses to rebuild a populated transfers table", async () => {
    // recreateTable would copy ISO TEXT verbatim into the new INTEGER columns
    // (read back as NaN). The ledger is unwritten in Phase 0, so a non-empty
    // table is an impossible state the migration must reject, not silently
    // corrupt — proving the guard fires before any rebuild.
    await postTransfers([tx()]);
    await expect(migration.up()).rejects.toThrow("refusing to retype");
  });
});
