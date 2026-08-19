import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  alsoAbout,
  encryptedPaymentColumn,
  encryptedPaymentColumnOrNull,
  keyWords,
  madeAndTouched,
  ownerEncryptedPaymentColumn,
  paymentRecord,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "#db/migrations/schema/payments/columns.ts";

describe("the kinds of column a payment record is built from", () => {
  // These say what a column is, and nothing about what a payment may say —
  // that is the record layer's job, in TypeScript, where a broken rule names
  // itself and can be changed without rebuilding a table full of real money.
  test("says a column's type and whether it may be missing, and no more", () => {
    expect(wholeNumber()).toBe("INTEGER NOT NULL");
    expect(wholeNumberOrNull()).toBe("INTEGER");
    expect(words()).toBe("TEXT NOT NULL");
    expect(wordsOrNull()).toBe("TEXT");
  });

  test("carries a starting value where a column has one", () => {
    expect(wholeNumber(1)).toBe("INTEGER NOT NULL DEFAULT 1");
    expect(words("none")).toBe("TEXT NOT NULL DEFAULT 'none'");
  });

  test("the record's own name cannot be nothing", () => {
    // A text primary key does not stop SQLite keeping NULL, so it is said
    // here: a payment with no id could never be looked up again.
    expect(keyWords()).toBe("TEXT PRIMARY KEY NOT NULL");
  });

  // The one rule the tables keep. It checks what actually landed in the
  // column rather than what the code meant to put there — the one thing
  // TypeScript cannot see, since a type says "string" while the value is
  // bytes.
  test("a hidden value must really be text, and carry every part", () => {
    expect(encryptedPaymentColumn("evidence")).toBe(
      "TEXT NOT NULL CHECK ((typeof(evidence) = 'text' AND evidence GLOB 'enc:1:?*:?*' AND evidence NOT GLOB 'enc:1:*:*:*'))",
    );
  });

  test("a hidden value that may be missing is checked only when it is there", () => {
    expect(encryptedPaymentColumnOrNull("decision")).toBe(
      "(decision IS NULL OR (typeof(decision) = 'text' AND decision GLOB 'enc:1:?*:?*' AND decision NOT GLOB 'enc:1:*:*:*'))",
    );
  });

  test("an owner-only value must carry the public-key envelope", () => {
    const rule = ownerEncryptedPaymentColumn("provider_reference");

    expect(rule).toContain("provider_reference GLOB 'hyb:1:?*:?*:?*'");
    expect(rule).toContain("provider_reference NOT GLOB 'hyb:1:*:*:*:*'");
    expect(rule).toContain("typeof(provider_reference) = 'text'");
  });

  test("every record says when it was made and last touched", () => {
    expect(madeAndTouched).toEqual([
      ["created_at", "INTEGER NOT NULL"],
      ["updated_at", "INTEGER NOT NULL"],
    ]);
  });

  test("rules about the whole row hang off its last column", () => {
    // SQLite gives a table nowhere else to say them.
    expect(alsoAbout(["a IS NULL", "b IS NULL"])("TEXT")).toBe(
      "TEXT\n          CHECK (a IS NULL)\n          CHECK (b IS NULL)",
    );
  });

  test("a row with nothing to say about it is left as it was", () => {
    expect(alsoAbout([])("TEXT")).toBe("TEXT");
  });

  test("every record hanging off a payment opens the same way", () => {
    const [name, table] = paymentRecord("payment_charges", {
      columns: [["captured_amount", "INTEGER"]],
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
