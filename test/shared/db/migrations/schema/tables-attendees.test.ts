/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeTables } from "#db/migrations/schema/tables-attendees.ts";
import { RECOVERY_NODES } from "#payment/sumup-recovery-machine-spec.ts";

/* jscpd:ignore-end */

const tableNamed = (name: string) => {
  const found = attendeeTables.find(([tableName]) => tableName === name);
  if (!found) throw new Error(`No ${name} table is declared`);
  return found[1];
};

const columnNamed = (table: string, column: string): string => {
  const found = tableNamed(table).columns.find(([name]) => name === column);
  if (!found) throw new Error(`${table} declares no ${column} column`);
  return found[1];
};

describe("attendee schema tables", () => {
  test("gives every staged SumUp checkout a state, defaulting to the start", () => {
    // The default decides what an upgrading site's existing rows become
    // before the migration derives them, so it has to be the start node.
    const declared = columnNamed("sumup_checkouts", "recovery_state");
    expect(declared).toBe("TEXT NOT NULL DEFAULT 'staged'");
    expect(RECOVERY_NODES.map((node) => node.id)).toContain("staged");
  });

  test("lets a checkout have no next check at all", () => {
    // A row nothing will ask about again stores no time, so the column has
    // to accept nothing — a NOT NULL here would force a meaningless date.
    expect(columnNamed("sumup_checkouts", "next_check_at")).toBe("TEXT");
  });

  test("indexes the queue the recovery task reads", () => {
    // Without this the task scans the table every time it runs.
    const index = tableNamed("sumup_checkouts").indexes?.find(
      (one) => one.name === "idx_sumup_checkouts_next_check",
    );
    expect(index?.columns).toEqual(["recovery_state", "next_check_at"]);
  });

  test("still finds a staged checkout by the id its callback names", () => {
    const index = tableNamed("sumup_checkouts").indexes?.find(
      (one) => one.name === "idx_sumup_checkouts_sumup_id",
    );
    expect(index?.columns).toEqual(["sumup_id"]);
  });

  test("keys a staged checkout by the one-way code for its reference", () => {
    // The plaintext reference never rests in this table; the row is found by
    // the code derived from it.
    expect(columnNamed("sumup_checkouts", "reference_index")).toBe(
      "TEXT PRIMARY KEY",
    );
  });
});
