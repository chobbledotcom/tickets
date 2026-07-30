import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  alsoAbout,
  amountOrNull,
  anyOf,
  currencyOrNull,
  encryptedPaymentColumn,
  encryptedPaymentColumnOrNull,
  keyWords,
  madeAndTouched,
  oneOf,
  oneOfOrNull,
  paymentRecord,
  sealedEitherWay,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "#shared/db/migrations/schema/payments/columns.ts";

describe("the kinds of column a payment record is built from", () => {
  test("a whole number must really be a number, not text that looks like one", () => {
    // SQLite will happily keep "12" in an INTEGER column, so the type is
    // checked outright rather than trusted.
    expect(wholeNumber("revision")).toBe(
      "INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0)",
    );
  });

  test("a whole number can be given a floor and a starting value", () => {
    expect(wholeNumber("revision", 1, 1)).toBe(
      "INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1)",
    );
  });

  test("a floor naming another column is checked to be there first", () => {
    // A comparison against a missing value passes in SQLite, so the column the
    // floor names has to exist before the comparison means anything.
    expect(wholeNumberOrNull("redacted_at", "created_at")).toBe(
      "INTEGER CHECK (redacted_at IS NULL OR (typeof(redacted_at) = 'integer' AND created_at IS NOT NULL AND redacted_at >= created_at))",
    );
  });

  test("a fixed floor needs no such check", () => {
    expect(wholeNumberOrNull("attendee_id", 1)).toBe(
      "INTEGER CHECK (attendee_id IS NULL OR (typeof(attendee_id) = 'integer' AND attendee_id >= 1))",
    );
  });

  test("a column given no floor may hold nothing but not less", () => {
    // Times are counted from the epoch, so nothing is a real value for one.
    // Floored at one instead, the earliest moment a site can record would be
    // turned away.
    expect(wholeNumberOrNull("alerted_at")).toBe(
      "INTEGER CHECK (alerted_at IS NULL OR (typeof(alerted_at) = 'integer' AND alerted_at >= 0))",
    );
  });

  test("money is kept inside the largest number that stays exact", () => {
    expect(amountOrNull("expected_amount", 0)).toBe(
      `INTEGER CHECK (expected_amount IS NULL OR (typeof(expected_amount) = 'integer' AND expected_amount BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}))`,
    );
  });

  test("text has to say something, not just hold spaces", () => {
    expect(words("payment_id")).toBe(
      "TEXT NOT NULL CHECK (typeof(payment_id) = 'text' AND length(trim(payment_id)) > 0)",
    );
    expect(wordsOrNull("lease_token")).toBe(
      "TEXT CHECK (lease_token IS NULL OR typeof(lease_token) = 'text' AND length(trim(lease_token)) > 0)",
    );
  });

  test("the record's own name cannot be nothing", () => {
    // A text primary key does not stop SQLite keeping NULL, so it is said here.
    expect(keyWords("id")).toBe(
      "TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(trim(id)) > 0)",
    );
  });

  test("only the listed words are allowed, with an optional starting one", () => {
    expect(oneOf("origin", ["current", "legacy"])).toBe(
      "TEXT NOT NULL CHECK (origin IN ('current', 'legacy'))",
    );
    expect(oneOf("state", ["none", "ready"], "none")).toBe(
      "TEXT NOT NULL DEFAULT 'none' CHECK (state IN ('none', 'ready'))",
    );
    expect(oneOfOrNull("mode", ["test", "live"])).toBe(
      "TEXT CHECK (mode IS NULL OR mode IN ('test', 'live'))",
    );
  });

  test("a currency is three capital letters", () => {
    expect(currencyOrNull("expected_currency")).toBe(
      "TEXT CHECK (expected_currency IS NULL OR typeof(expected_currency) = 'text' AND expected_currency GLOB '[A-Z][A-Z][A-Z]')",
    );
  });

  test("a hidden value must carry every part needed to read it back", () => {
    // GLOB's ?* swallows extra separators, so the second half refuses one
    // separator more than the envelope has.
    expect(encryptedPaymentColumn("evidence")).toBe(
      "TEXT NOT NULL CHECK ((typeof(evidence) = 'text' AND evidence GLOB 'enc:1:?*:?*' AND evidence NOT GLOB 'enc:1:*:*:*'))",
    );
  });

  test("a hidden value that may be missing is checked only when it is there", () => {
    expect(encryptedPaymentColumnOrNull("decision")).toBe(
      "(decision IS NULL OR (typeof(decision) = 'text' AND decision GLOB 'enc:1:?*:?*' AND decision NOT GLOB 'enc:1:*:*:*'))",
    );
  });

  test("a provider's own name may be hidden either way", () => {
    const rule = sealedEitherWay("provider_reference");

    expect(rule).toContain("provider_reference GLOB 'enc:1:?*:?*'");
    expect(rule).toContain("provider_reference GLOB 'hyb:1:?*:?*:?*'");
    expect(rule).toContain("provider_reference NOT GLOB 'hyb:1:*:*:*:*'");
    expect(rule).toContain("length(trim(provider_reference)) > 0");
  });

  test("joins rules of which one must hold", () => {
    expect(anyOf(["a = 1", "b = 2"])).toBe("(a = 1 OR b = 2)");
  });

  test("every record says when it was made and last touched", () => {
    // Both rules in full: each names the column it is about, so a rule that
    // lost that name would compare against nothing and let anything through.
    expect(madeAndTouched).toEqual([
      [
        "created_at",
        "INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)",
      ],
      [
        "updated_at",
        "INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND created_at IS NOT NULL AND updated_at >= created_at)",
      ],
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
      // The payment it belongs to must say something: a record hanging off a
      // blank one belongs to no payment anybody can find.
      [
        "payment_id",
        "TEXT NOT NULL CHECK (typeof(payment_id) = 'text' AND length(trim(payment_id)) > 0)",
      ],
      ["captured_amount", "INTEGER"],
    ]);
    expect(table.indexes).toEqual([
      { columns: ["payment_id"], name: "idx_charges_payment" },
    ]);
  });
});
