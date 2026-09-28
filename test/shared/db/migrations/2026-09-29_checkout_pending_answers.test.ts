import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import checkoutPendingAnswers from "#db/migrations/2026-09-29_checkout_pending_answers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => checkoutPendingAnswers(buildMigrationContext());

describeWithEnv(
  "db > migrations > checkout pending answers",
  { db: true },
  () => {
    test("declares the table it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-09-29_checkout_pending_answers");
      expect(migration().requires).toEqual({
        indexes: [],
        newTables: ["checkout_pending_answers"],
      });
    });
  },
);
