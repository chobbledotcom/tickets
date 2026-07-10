import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  createLegacyMigrationHarness,
  stubPragmaForeignKeysOff,
} from "./helpers.ts";

describe("db > legacy migration harness > stubPragmaForeignKeysOff", () => {
  const h = createLegacyMigrationHarness();
  afterEach(h.cleanup);

  test("reports PRAGMA foreign_keys = OFF as a no-op but passes other SQL through", async () => {
    const client = await h.newFileDb();
    await client.execute("CREATE TABLE probe (value INTEGER)");
    await client.execute("PRAGMA foreign_keys = ON");

    using _stub = stubPragmaForeignKeysOff(client);

    // Simulates remote libsql (Turso): the pragma is acknowledged with an
    // empty result but never actually disables foreign keys.
    const off = await client.execute("PRAGMA foreign_keys = OFF");
    expect(off.rowsAffected).toBe(0);
    expect(off.rows).toEqual([]);
    expect(off.toJSON()).toEqual({
      columns: [],
      columnTypes: [],
      lastInsertRowid: "0",
      rows: [],
      rowsAffected: 0,
    });

    // The real setting is untouched: enforcement stays on, which is the whole
    // point of the stub (a genuine OFF here would report an empty result too).
    const foreignKeys = await client.execute("PRAGMA foreign_keys");
    expect(foreignKeys.rows).toEqual([{ foreign_keys: 1 }]);

    // Every other statement runs against the real database.
    await client.execute("INSERT INTO probe (value) VALUES (7)");
    const rows = await client.execute("SELECT value FROM probe");
    expect(rows.rows).toEqual([{ value: 7 }]);
  });
});
