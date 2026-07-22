import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  RESTORE_DEFERRED_TRIGGERS,
  TRIGGERS,
} from "#shared/db/migrations/schema/triggers.ts";

test("keeps only validation triggers active during restore imports", () => {
  const deferredNames = new Set(
    RESTORE_DEFERRED_TRIGGERS.map(({ name }) => name),
  );

  expect(
    TRIGGERS.filter(({ name }) => !deferredNames.has(name)).map(
      ({ name }) => name,
    ),
  ).toEqual([
    "trg_attendee_answers_validate_insert",
    "trg_attendee_answers_validate_update",
    "trg_attendees_validate_status_insert",
    "trg_attendees_validate_status_update",
  ]);
});
