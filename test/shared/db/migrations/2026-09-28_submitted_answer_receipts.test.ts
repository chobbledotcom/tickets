import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import submittedAnswerReceipts from "#db/migrations/2026-09-28_submitted_answer_receipts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => submittedAnswerReceipts(buildMigrationContext());

describeWithEnv(
  "db > migrations > submitted answer receipts",
  { db: true },
  () => {
    test("declares the tables, indexes, and triggers it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-09-28_submitted_answer_receipts");
      expect(migration().description).toBe(
        "Keep original answer wording for each booked line and retain owner-sealed submitted text",
      );
      expect(migration().requires).toEqual({
        indexes: [
          "idx_submitted_answer_receipt_lines_unique",
          "idx_submitted_answer_receipt_lines_string_id",
        ],
        newTables: [
          "submitted_answer_receipts",
          "submitted_answer_receipt_lines",
        ],
        triggers: [
          "trg_submitted_answer_receipt_strings_insert",
          "trg_submitted_answer_receipt_strings_delete",
        ],
      });
    });
  },
);
