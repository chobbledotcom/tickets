import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  APP_SCHEMA,
  SCHEMA,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations/schema/index.ts";
import { paymentTables } from "#shared/db/migrations/schema/payments/index.ts";
import { attendeeTables } from "#shared/db/migrations/schema/tables-attendees.ts";
import { catalogTables } from "#shared/db/migrations/schema/tables-catalog.ts";
import { contentTables } from "#shared/db/migrations/schema/tables-content.ts";
import { coreTables } from "#shared/db/migrations/schema/tables-core.ts";
import { questionTables } from "#shared/db/migrations/schema/tables-questions.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "#shared/db/migrations/schema/version.ts";

describe("db > migrations > schema assembly", () => {
  test("puts every group in the order the foreign keys need", () => {
    // A table has to be created after the tables it points at, so this order
    // is the schema, not a tidy way of listing it.
    expect(SCHEMA).toEqual([
      ...coreTables,
      ...attendeeTables,
      ...catalogTables,
      ...questionTables,
      ...contentTables,
      ...paymentTables,
    ]);
  });

  test("names the tables in that same order", () => {
    expect(SCHEMA_TABLE_NAMES).toEqual(SCHEMA.map(([name]) => name));
  });

  test("leaves the migrations bookkeeping table out of the app schema", () => {
    // The bookkeeping table is the app's own record of what it has run, so a
    // site's schema is compared without it.
    expect(SCHEMA_TABLE_NAMES).toContain(SCHEMA_MIGRATIONS_TABLE);
    // Compared whole rather than by name and count, so a table swapped for
    // another, or listed twice, cannot slip through.
    expect(APP_SCHEMA).toEqual(
      SCHEMA.filter(([name]) => name !== SCHEMA_MIGRATIONS_TABLE),
    );
  });

  test("stamps the schema with the hash a site is checked against", () => {
    // A site whose stored hash differs from this one gets migrated, so the
    // value is pinned. The schema change guard pins the same value beside the
    // migration list; this one keeps the stamp tied to the schema it is of.
    expect(SCHEMA_HASH).toBe("xi15gs");
  });
});
