/**
 * Pure unit tests for the attendee-sort picklist guard that `queries.ts`
 * exports. Table-driven and deterministic — no DB needed.
 */

import { describe } from "@std/testing/bdd";
import { isAttendeeSort } from "#shared/db/attendees/queries.ts";
import { checkBothArms } from "#test-utils/picklist-guard.ts";

describe("AttendeeSort picklist", () => {
  checkBothArms(
    isAttendeeSort,
    ["newest", "oldest"],
    ["", "new", "old", "recent", "Newest"],
  );
});
