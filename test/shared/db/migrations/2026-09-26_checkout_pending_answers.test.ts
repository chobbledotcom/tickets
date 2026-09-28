import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import checkoutPendingAnswers from "#db/migrations/2026-09-26_checkout_pending_answers.ts";
import registrationEmailWork from "#db/migrations/2026-09-29_registration_email_work.ts";
import submittedAnswerReceipts from "#db/migrations/2026-09-28_submitted_answer_receipts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext();

describeWithEnv(
  "db > migrations > checkout work staging",
  { db: true },
  () => {
    test("the staged-answer migration declares the table and its indexes", () => {
      const migration = checkoutPendingAnswers(context);

      expect(migration.id).toBe("2026-09-26_checkout_pending_answers");
      expect(migration.description).toBe(
        "Stage a checkout's answers under the hash of its session id, sealed with the checkout work key, so the confirmation email can show them without the owner key",
      );
      expect(migration.requires).toEqual({
        indexes: [
          "idx_checkout_pending_answers_due",
          "idx_checkout_pending_answers_attendee",
        ],
        newTables: ["checkout_pending_answers"],
      });
    });

    test("the receipt migration declares its tables, indexes, and triggers", () => {
      const migration = submittedAnswerReceipts(context);

      expect(migration.id).toBe("2026-09-28_submitted_answer_receipts");
      expect(migration.description).toBe(
        "Keep original answer wording for each booked line and retain owner-sealed submitted text",
      );
      expect(migration.requires).toEqual({
        indexes: [
          "idx_submitted_answer_receipt_lines_unique",
          "idx_submitted_answer_receipt_lines_string_id",
        ],
        newTables: ["submitted_answer_receipts", "submitted_answer_receipt_lines"],
        triggers: [
          "trg_submitted_answer_receipt_strings_insert",
          "trg_submitted_answer_receipt_strings_delete",
        ],
      });
    });

    test("the outbox migration declares the work table and its indexes", () => {
      const migration = registrationEmailWork(context);

      expect(migration.id).toBe("2026-09-29_registration_email_work");
      expect(migration.description).toBe(
        "Keep each registration email retryable without storing its plaintext in the database",
      );
      expect(migration.requires).toEqual({
        indexes: [
          "idx_registration_email_work_identity",
          "idx_registration_email_work_due",
          "idx_registration_email_work_attendee",
        ],
        newTables: ["registration_email_work"],
      });
    });
  },
);
