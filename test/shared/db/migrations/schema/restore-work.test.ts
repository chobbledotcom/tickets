import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  RESTORE_DEFERRED_INDEXES,
  RESTORE_DEFERRED_TRIGGERS,
} from "#db/migrations/schema/restore-work.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";

test("defers non-unique indexes but keeps unique checks active", () => {
  expect(
    RESTORE_DEFERRED_INDEXES.find(
      ({ name }) => name === "idx_maintenance_tasks_due",
    ),
  ).toEqual({
    name: "idx_maintenance_tasks_due",
    sql: "CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due ON maintenance_tasks(next_run_at, lease_expires_at, name)",
  });
  expect(
    RESTORE_DEFERRED_INDEXES.some(
      ({ name }) => name === "idx_listings_slug_index",
    ),
  ).toBe(false);
});

test("keeps only validation triggers active during restore imports", () => {
  const deferredNames = RESTORE_DEFERRED_TRIGGERS.map(({ name }) => name);

  expect(
    TRIGGERS.filter(({ name }) => !deferredNames.includes(name)).map(
      ({ name }) => name,
    ),
  ).toEqual([
    "trg_attendee_answers_validate_insert",
    "trg_attendee_answers_validate_update",
    "trg_attendees_validate_status_insert",
    "trg_attendees_validate_status_update",
  ]);
});
