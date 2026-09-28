import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import checkoutPendingAnswers from "#db/migrations/2026-09-26_checkout_pending_answers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => checkoutPendingAnswers(buildMigrationContext());

describeWithEnv(
  "db > migrations > checkout pending answers",
  { db: true },
  () => {
    test("declares the staged-answer table and the indexes it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-09-26_checkout_pending_answers");
      expect(migration().description).toBe(
        "Stage a checkout's answers under the hash of its session id, sealed with the checkout work key, so the confirmation email can show them without the owner key",
      );
      expect(migration().requires).toEqual({
        indexes: [
          "idx_checkout_pending_answers_due",
          "idx_checkout_pending_answers_attendee",
        ],
        newTables: ["checkout_pending_answers"],
      });
    });
  },
);
