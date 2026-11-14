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
import { testColumnFragments } from "#test-utils/column-fragments.ts";
import { sqlText } from "#test-utils/sql-text.ts";

describe("the kinds of column a payment record is built from", () => {
  // These say what a column is, and nothing about what a payment may say —
  // that is the record layer's job, in TypeScript, where a broken rule names
  // itself and can be changed without rebuilding a table full of real money.
  testColumnFragments([
    {
      fragment: ownerEncryptedColumn("evidence"),
      name: "a hidden value is required text, and must carry every part",
      text: [
        "evidence",
        "TEXT NOT NULL CHECK ((typeof(evidence) = 'text' AND evidence GLOB 'hyb:1:?*:?*:?*' AND evidence NOT GLOB 'hyb:1:*:*:*:*'))",
      ],
    },
    {
      // The rule goes inside a CHECK, which supplies the outer brackets.
      fragment: ownerEncryptedRuleOrNull("decision"),
      name: "a hidden value a row can leave empty is checked only when it is there",
      text: "decision IS NULL OR (typeof(decision) = 'text' AND decision GLOB 'hyb:1:?*:?*:?*' AND decision NOT GLOB 'hyb:1:*:*:*:*')",
    },
    {
      fragment: madeAndTouched,
      name: "every record says when it was made and last touched",
      text: [
        ["created_at", "INTEGER NOT NULL"],
        ["updated_at", "INTEGER NOT NULL"],
      ],
    },
  ]);

  test("every record hanging off a payment opens the same way", () => {
    const [name, table] = paymentRecord("payment_charges", {
      columns: [["captured_amount", sql`INTEGER`]],
      indexes: [{ columns: ["payment_id"], name: "idx_charges_payment" }],
    });

    expect(sqlText(name)).toBe("payment_charges");
    expect(sqlText(table.columns)).toEqual([
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL"],
      ["captured_amount", "INTEGER"],
    ]);
    expect(sqlText(table.indexes)).toEqual([
      { columns: ["payment_id"], name: "idx_charges_payment" },
    ]);
  });
});
