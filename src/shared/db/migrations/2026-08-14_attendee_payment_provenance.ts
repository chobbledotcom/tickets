import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-14_attendee_payment_provenance",
  "Record which canonical payment row proves a new attendee's encrypted payment id, while leaving historical rows explicitly unqualified",
  { columns: { attendees: ["pii_payment_session_id"] } },
);
