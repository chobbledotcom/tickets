import { execute } from "#db/client.ts";

/** Seed visit history without exposing a production write API used by no route. */
export const setContactVisits = async (
  contactHash: string,
  visits: number,
): Promise<void> => {
  await execute(
    `INSERT INTO contact_preferences (contact_hash, last_activity, visits)
     VALUES (?, ?, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       last_activity = excluded.last_activity,
       visits = excluded.visits`,
    [contactHash, Date.now(), visits],
  );
};
