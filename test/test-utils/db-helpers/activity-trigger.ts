import { execute } from "#db/client.ts";

/** Reject exactly the attendee-linked activity inserts: the registration
 *  lines the booking batches write. Every other activity write (admin notes
 *  with no attendee, and any fixture that avoids attendee-linked lines)
 *  passes. Drop the trigger in a `finally` so the shared test database keeps
 *  working for the tests that follow. */
export const installRejectingActivityTrigger = async (): Promise<void> => {
  await execute(
    `CREATE TRIGGER reject_registration_activity
     BEFORE INSERT ON activity_log
     WHEN NEW.attendee_id IS NOT NULL
     BEGIN
       SELECT RAISE(ABORT, 'registration activity rejected');
     END`,
    [],
  );
};

export const dropRejectingActivityTrigger = async (): Promise<void> => {
  await execute("DROP TRIGGER IF EXISTS reject_registration_activity", []);
};
