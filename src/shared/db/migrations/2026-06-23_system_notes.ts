import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-23_system_notes",
  "Add system_notes table of per-attendee operator-visible notes (encrypted: system notes with DB_ENCRYPTION_KEY, owner notes with the owner public key). (This historically also owned an attendee_id column and its idx_system_notes_attendee_id index, since replaced — a note now names the kind of record it is about and which one; see 2026-07-28_note_entities.)",
  {
    newTables: ["system_notes"],
  },
);
