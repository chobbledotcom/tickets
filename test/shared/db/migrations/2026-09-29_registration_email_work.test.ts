import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import registrationEmailWork from "#db/migrations/2026-09-29_registration_email_work.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => registrationEmailWork(buildMigrationContext());

describeWithEnv(
  "db > migrations > registration email work",
  { db: true },
  () => {
    test("declares the outbox table and the indexes it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-09-29_registration_email_work");
      expect(migration().description).toBe(
        "Keep each registration email retryable without storing its plaintext in the database",
      );
      expect(migration().requires).toEqual({
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
