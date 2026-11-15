import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { invoiceTables } from "#db/migrations/schema/tables-invoices.ts";
import {
  expectSchemaDeclarationExact,
  schemaTableNamed,
} from "#test-utils/db/schema-declaration.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete invoice schema declaration exact", async () => {
  await expectSchemaDeclarationExact(
    invoiceTables,
    "ff60926fcd2528a9b4d80749cc00e8136dbfe8a89835bc233c6ac155ad9d9b4e",
  );
});

test("holds at most one open invoice per attendee", () => {
  expect(
    sqlText(schemaTableNamed(invoiceTables, "invoices").indexes),
  ).toContainEqual({
    columns: ["attendee_id"],
    name: "idx_invoices_open_attendee",
    unique: true,
    where: "status = 'new'",
  });
});
