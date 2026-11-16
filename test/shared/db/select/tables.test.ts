/**
 * Tests for `src/shared/db/select/tables.ts`: the tables as a read sees them,
 * checked against the declared schema and a real database.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { queryAll } from "#db/client.ts";
import { TYPED_SCHEMA } from "#db/migrations/schema/index.ts";
import { REFERENCES } from "#db/migrations/schema/references.ts";
import { columnFacts } from "#db/migrations/schema/scalar-columns.ts";
import { literal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import {
  referenceOf,
  type TableHandle,
  tableNamed,
  tables,
} from "#db/select/tables.ts";
import { type Read, sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describe("tables", () => {
  test("holds each table under its name, with its singular word", () => {
    expect(tables.listing_attendees.name).toBe("listing_attendees");
    expect(tables.listing_attendees.singular).toBe("listingAttendee");
    expect(tables.listing_attendees.columns).toBe(
      TYPED_SCHEMA.find(([name]) => name === "listing_attendees")?.[1].columns,
    );
  });
});

describe("tableNamed", () => {
  test("gives the declared table of that name", () => {
    expect(tableNamed("holidays")).toBe(tables.holidays);
  });

  test("refuses a name that no table has", () => {
    expect(() => tableNamed("things")).toThrow(
      "things is not a declared table",
    );
    expect(() => tableNamed("constructor")).toThrow(
      "constructor is not a declared table",
    );
  });
});

describe("referenceOf", () => {
  test("names the referring column and the table it points at", () => {
    expect(referenceOf(tables.listing_attendees, "listing")).toEqual({
      column: "listing_id",
      optional: false,
      target: tables.listings,
    });
  });

  test("marks a reference whose column can hold nothing", () => {
    expect(referenceOf(tables.attendees, "status")).toEqual({
      column: "status_id",
      optional: true,
      target: tables.attendee_statuses,
    });
  });

  test("refuses a key with no column", () => {
    expect(() => referenceOf(tables.listings as TableHandle, "status")).toThrow(
      "listings has no status_id column to join along",
    );
  });

  test("refuses a column that refers to no table", () => {
    expect(() =>
      referenceOf(tables.external_source_links as TableHandle, "external"),
    ).toThrow("external_source_links.external_id does not refer to a table");
  });
});

const referringColumns = Object.entries(REFERENCES).flatMap(
  ([table, targets]) =>
    Object.keys(targets).map((column) => ({
      column,
      table,
    })),
);

describeWithEnv("the declared schema", { db: true }, () => {
  test("joins along every declared reference in the database", async () => {
    for (const { column, table } of referringColumns) {
      const key = column.slice(0, -"_id".length);
      const read = from(
        tableNamed(table) as TableHandle<"listings">,
        {
          [key]: {},
        } as never,
      ).select(() => ({ one: literal(1) }));
      expect(await queryAll(read)).toEqual([]);
    }
    expect(referringColumns.length).toBeGreaterThan(40);
  });

  test("marks a column that can hold nothing as the database does", async () => {
    for (const [name, table] of TYPED_SCHEMA) {
      const live = await queryAll<{
        name: string;
        notnull: number;
        pk: number;
      }>(sql`SELECT name, "notnull", pk FROM pragma_table_info(${name})`);
      const declared = table.columns.map(([column, type]) => ({
        canBeNull: columnFacts(type).canBeNull,
        column,
      }));
      expect(declared).toEqual(
        live.map((column) => ({
          canBeNull: column.notnull === 0 && column.pk === 0,
          column: column.name,
        })),
      );
    }
  });

  test("gives a row the decoded value of a sealed column", async () => {
    await queryAll(
      insertInto(tables.holidays, {
        endDate: "2026-01-02",
        name: await encrypt("h"),
        startDate: "2026-01-01",
      }),
    );
    const rows = await queryAll(
      from(tables.holidays).select((holiday) => ({
        id: holiday.id,
        name: holiday.name,
      })),
    );
    const [row] = rows;
    const id: number = row!.id;
    const name: string = row!.name;
    expect({ id, name }).toEqual({ id: 1, name: "h" });
  });

  test("refuses a row type that the read does not give", () => {
    const read = from(tables.holidays).pick("id", "name");
    const wider: Read<{ id: number }> = read;
    // @ts-expect-error the read gives a number for `id`
    const refused: Read<{ id: string }> = read;
    // @ts-expect-error the read gives no `slug`
    const missing: Read<{ slug: string }> = read;
    expect([wider.sql, refused.sql, missing.sql]).toEqual([
      read.sql,
      read.sql,
      read.sql,
    ]);
  });

  test("gives a column the values that the schema names for it", () => {
    const read = from(tables.system_notes).pick("type", "entityType");
    const typed: Read<{ type: "system" | "owner" }> = read;
    // @ts-expect-error a note is of the system or of the owner
    const refused: Read<{ type: "system" }> = read;
    expect(typed.sql).toBe(refused.sql);
  });
});
