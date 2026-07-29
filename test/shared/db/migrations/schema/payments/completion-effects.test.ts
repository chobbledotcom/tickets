import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionEffectsTable } from "#shared/db/migrations/schema/payments/completion-effects.ts";

const [name, table] = paymentCompletionEffectsTable;
const column = (wanted: string): string =>
  table.columns.find(([held]) => held === wanted)?.[1] ?? "";

describe("the work done after a payment", () => {
  test("is one row per piece of work per payment", () => {
    expect(name).toBe("payment_completion_effects");
    expect(table.columns.map(([held]) => held)).toEqual([
      "id",
      "payment_id",
      "effect",
      "record_id",
      "completed_at",
    ]);
  });

  test("names the work with something, not a blank", () => {
    expect(column("effect")).toContain("length(trim(effect)) > 0");
  });

  test("only records work that has been done", () => {
    // Unlike a message waiting to be sent, a piece of work is written down
    // once it has happened, so its time is always there.
    expect(column("completed_at")).toContain("INTEGER NOT NULL");
    expect(column("completed_at")).toContain("typeof(completed_at)");
  });

  test("points at a real row when it points at one at all", () => {
    expect(column("record_id")).toContain("record_id IS NULL OR");
    expect(column("record_id")).toContain("record_id >= 1");
  });

  test("cannot do the same piece of work for a payment twice", () => {
    // This is what stops a retry booking a second ticket for one payment.
    expect(table.indexes).toEqual([
      {
        columns: ["payment_id", "effect"],
        name: "idx_payment_completion_effects_unique",
        unique: true,
      },
    ]);
  });
});
