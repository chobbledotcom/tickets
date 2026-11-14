/** The columns a payment record is built from. A flipped word here changes a
 *  table that already holds real money, so pin every one exactly. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  madeAndTouched,
  ownerEncryptedColumn,
  ownerEncryptedRuleOrNull,
  paymentRecord,
} from "#db/migrations/schema/payments/columns.ts";
import { sql } from "#db/sql.ts";

describe("the kinds of column a payment record is built from", () => {
  // These say what a column is, and nothing about what a payment may say —
  // that is the record layer's job, in TypeScript, where a broken rule names
  // itself and can be changed without rebuilding a table full of real money.
  test("a hidden value is required text, and must carry every part", () => {
    expect(ownerEncryptedColumn("evidence")).toEqual([
      "evidence",
      "TEXT NOT NULL CHECK ((typeof(evidence) = 'text' AND evidence GLOB 'hyb:1:?*:?*:?*' AND evidence NOT GLOB 'hyb:1:*:*:*:*'))",
    ]);
  });

  test("a hidden value a row can leave empty is checked only when it is there", () => {
    // The rule goes inside a CHECK, which supplies the outer brackets.
    expect(ownerEncryptedRuleOrNull("decision")).toBe(
      "decision IS NULL OR (typeof(decision) = 'text' AND decision GLOB 'hyb:1:?*:?*:?*' AND decision NOT GLOB 'hyb:1:*:*:*:*')",
    );
  });

  test("every record says when it was made and last touched", () => {
    expect(madeAndTouched).toEqual([
      ["created_at", "INTEGER NOT NULL"],
      ["updated_at", "INTEGER NOT NULL"],
    ]);
  });

  test("every record hanging off a payment opens the same way", () => {
    const [name, table] = paymentRecord("payment_charges", {
      columns: [["captured_amount", sql`INTEGER`]],
      indexes: [{ columns: ["payment_id"], name: "idx_charges_payment" }],
    });

    expect(name).toBe("payment_charges");
    expect(table.columns).toEqual([
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL"],
      ["captured_amount", "INTEGER"],
    ]);
    expect(table.indexes).toEqual([
      { columns: ["payment_id"], name: "idx_charges_payment" },
    ]);
  });
});
