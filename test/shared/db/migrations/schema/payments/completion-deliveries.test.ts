import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionDeliveriesTable } from "#db/migrations/schema/payments/completion-deliveries.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testColumnSql } from "#test-utils/schema-column-cases.ts";
import { expectSchemaColumns } from "#test-utils/schema-columns.ts";
import { columnSql } from "./column-sql.ts";
import { expectAccepted, expectRefused } from "./refuses.ts";

const [, table] = paymentCompletionDeliveriesTable;

describe("the messages sent after a payment", () => {
  test("is one row per message per payment", () => {
    expectSchemaColumns(
      paymentCompletionDeliveriesTable,
      "payment_completion_deliveries",
      ["id", "payment_id", "delivery_key", "data", "completed_at"],
    );
  });

  test("demands the message be hidden, because it holds the buyer's details", () => {
    // Name, email, phone and address travel in here, so the table refuses a
    // plain one rather than trusting every writer to hide it.
    assertStringIncludes(columnSql(table, "data"), "GLOB 'hyb:1:?*:?*:?*'");
    assertStringIncludes(columnSql(table, "data"), "TEXT NOT NULL");
  });

  // Empty until it goes out, which is what makes "which messages are still
  // waiting?" a cheap question.
  testColumnSql(table, [
    ["lets a message wait until it has been sent", "completed_at", "INTEGER"],
  ]);

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

// Read as a string the rule above looks right whatever column it names, so
// this asks a real table to turn a plain message away.
describeWithEnv("db > message rules", { db: true }, () => {
  const aMessage = (key: string, data: string) =>
    sql`INSERT INTO payment_completion_deliveries
      (payment_id, delivery_key, data)
      VALUES ('pay_1', ${key}, ${data})`;

  for (const [name, data] of [
    ["left in plain words", "Jane Smith"],
    ["held under the database owner's key", "enc:1:a:b"],
    ["behind an upper-case envelope", "HYB:1:a:b:c"],
    ["wearing an envelope with nothing in it", "hyb:1:Jane Smith"],
  ] as const) {
    test(`refuses a message ${name}`, async () => {
      await expectRefused(aMessage("plain", data));
    });
  }

  test("refuses a message that is bytes only reading like an envelope", async () => {
    await expectRefused(sql`INSERT INTO payment_completion_deliveries
        (payment_id, delivery_key, data)
        VALUES ('pay_1', 'bytes', ${new TextEncoder().encode("hyb:1:a:b:c")})`);
  });

  test("accepts a message that is hidden", async () => {
    await expectAccepted(aMessage("hidden", "hyb:1:a:b:c"));
  });
});
