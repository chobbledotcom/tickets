import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { invoiceTables } from "#db/migrations/schema/tables-invoices.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete invoice schema declaration exact", async () => {
  expect(await jsonHash(sqlText(invoiceTables))).toBe(
    "ff60926fcd2528a9b4d80749cc00e8136dbfe8a89835bc233c6ac155ad9d9b4e",
  );
});

test("holds at most one open invoice per attendee", () => {
  const invoices = invoiceTables.find(([name]) => name === "invoices");
  if (!invoices) throw new Error("invoices schema is missing");

  expect(sqlText(invoices[1].indexes)).toContainEqual({
    columns: ["attendee_id"],
    name: "idx_invoices_open_attendee",
    unique: true,
    where: "status = 'new'",
  });
});
