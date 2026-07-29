import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionDeliveriesTable } from "#shared/db/migrations/schema/payments/completion-deliveries.ts";

const [name, table] = paymentCompletionDeliveriesTable;
const column = (wanted: string): string =>
  table.columns.find(([held]) => held === wanted)?.[1] ?? "";

describe("the messages sent after a payment", () => {
  test("is one row per message per payment", () => {
    expect(name).toBe("payment_completion_deliveries");
    expect(table.columns.map(([held]) => held)).toEqual([
      "id",
      "payment_id",
      "delivery_key",
      "data",
      "completed_at",
    ]);
  });

  test("demands the message be hidden, because it holds the buyer's details", () => {
    // Name, email, phone and address travel in here, so the table refuses a
    // plain one rather than trusting every writer to hide it.
    expect(column("data")).toContain("GLOB 'enc:1:?*:?*'");
    expect(column("data")).toContain("TEXT NOT NULL");
  });

  test("names the message with something, not a blank", () => {
    expect(column("delivery_key")).toContain("length(trim(delivery_key)) > 0");
  });

  test("lets a message wait, and says when it was sent", () => {
    expect(column("completed_at")).toContain("completed_at IS NULL OR");
  });

  test("cannot send the same message for a payment twice", () => {
    // Without this the buyer could be emailed twice by two workers.
    expect(table.indexes).toContainEqual({
      columns: ["payment_id", "delivery_key"],
      name: "idx_payment_completion_deliveries_unique",
      unique: true,
    });
  });

  test("can find the messages still waiting to be sent", () => {
    expect(table.indexes).toContainEqual({
      columns: ["payment_id", "completed_at", "id"],
      name: "idx_payment_completion_deliveries_pending",
    });
  });
});
