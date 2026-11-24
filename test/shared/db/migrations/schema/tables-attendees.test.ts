import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeTables } from "#db/migrations/schema/tables-attendees.ts";
import { RECOVERY_NODES } from "#payment/sumup-recovery-machine-spec.ts";
import { schemaTableNamed } from "#test-utils/db/schema-declaration.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete attendee schema declaration exact", async () => {
  expect(await jsonHash(sqlText(attendeeTables))).toBe(
    "87d162e03f221f8d0aef43bd70f0150c8efb34d4364e3d29e3580696ce71f32b",
  );
});

const tableNamed = (name: string) => schemaTableNamed(attendeeTables, name);

const columnNamed = (table: string, column: string): string => {
  const found = tableNamed(table).columns.find(([name]) => name === column);
  if (!found) throw new Error(`${table} declares no ${column} column`);
  return found[1].sql;
};

/** The columns one declared index covers, in order, failing when the table
 *  declares no index under that name. */
const indexColumns = (table: string, indexName: string): readonly string[] => {
  const found = tableNamed(table).indexes?.find(
    (one) => one.name === indexName,
  );
  if (!found) throw new Error(`${table} declares no ${indexName} index`);
  return found.columns;
};

describe("attendee schema tables", () => {
  test("indexes subscribed bookings by status, then Stripe id", () => {
    expect(
      indexColumns("listing_attendees", "idx_listing_attendees_subscription"),
    ).toEqual(["subscription_status", "subscription_id"]);
  });

  test("gives every staged SumUp checkout a state, defaulting to the start", () => {
    // The default decides what an upgrading site's existing rows become
    // before the migration derives them, so it has to be the start node.
    const declared = columnNamed("sumup_checkouts", "recovery_state");
    expect(sqlText(declared)).toBe("TEXT NOT NULL DEFAULT 'staged'");
    assertArrayIncludes(
      RECOVERY_NODES.map((node) => node.id),
      ["staged"],
    );
  });

  test("lets a checkout have no next check at all", () => {
    // A row nothing will ask about again stores no time, so the column has
    // to accept nothing — a NOT NULL here would force a meaningless date.
    expect(sqlText(columnNamed("sumup_checkouts", "next_check_at"))).toBe(
      "TEXT",
    );
  });

  test("indexes the queue the recovery task reads", () => {
    // Without this the task scans the table every time it runs.
    expect(
      indexColumns("sumup_checkouts", "idx_sumup_checkouts_next_check"),
    ).toEqual(["recovery_state", "next_check_at"]);
  });

  test("still finds a staged checkout by the id its callback names", () => {
    expect(
      indexColumns("sumup_checkouts", "idx_sumup_checkouts_sumup_id"),
    ).toEqual(["sumup_id"]);
  });

  test("keys a staged checkout by the one-way code for its reference", () => {
    // The plaintext reference never rests in this table; the row is found by
    // the code derived from it.
    expect(sqlText(columnNamed("sumup_checkouts", "reference_index"))).toBe(
      "TEXT PRIMARY KEY",
    );
  });
});
