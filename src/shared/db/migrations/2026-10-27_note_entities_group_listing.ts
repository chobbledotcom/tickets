import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-10-27_note_entities_group_listing",
  "Let notes be about groups and listings, as well as attendees",
  async ({ recreateTable }) => {
    // The system_notes CHECK is built from NOTE_ENTITIES, so an existing
    // database still carries the attendee-only CHECK. SQLite cannot relax a
    // CHECK in place — the table must be rebuilt from SCHEMA, which now names
    // all three kinds. No table holds a FK to system_notes (each record's
    // delete path prunes its notes explicitly), so the rebuild is safe.
    await recreateTable("system_notes");
  },
);
