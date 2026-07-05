import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-23_system_notes",
  "Add system_notes table of per-attendee operator-visible notes (encrypted: system notes with DB_ENCRYPTION_KEY, owner notes with the owner public key)",
  {
    indexes: ["idx_system_notes_attendee_id"],
    newTables: ["system_notes"],
  },
);
