import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";

/** Seed visit history without exposing a production write API used by no route. */
export const setContactVisits = async (
  contactHash: string,
  visits: number,
): Promise<void> => {
  await execute(
    sql`INSERT INTO contact_preferences (contact_hash, last_activity, visits)
     VALUES (${contactHash}, ${Date.now()}, ${visits})
     ON CONFLICT(contact_hash) DO UPDATE SET
       last_activity = excluded.last_activity,
       visits = excluded.visits`,
  );
};
