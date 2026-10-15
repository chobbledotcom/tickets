import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-12_pending_notification_flags",
  "Record on each attendee whether its confirmation email or registration webhooks are still owed, and who the booking came from, so a failed send is visible to the admin instead of silent. Every existing booking defaults to not pending, so old bookings show no badge.",
  {
    columns: {
      attendees: ["email_pending", "webhooks_pending"],
    },
  },
);
