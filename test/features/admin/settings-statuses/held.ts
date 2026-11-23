import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Create a status through the admin form and return its id. */
export const create = async (
  name: string,
  extra: Record<string, string> = {},
): Promise<number> => {
  await adminFormPost("/admin/settings/statuses", { name, ...extra });
  return (await attendeeStatuses.getAll()).find((one) => one.name === name)!.id;
};

/** The id of the status that one attendee holds. */
export const statusIdOf = async (attendeeId: number): Promise<number> => {
  const rows = await execute(
    sql`SELECT status_id FROM attendees WHERE id = ${attendeeId}`,
  );
  return Number(rows.rows[0]!.status_id);
};

/** One attendee sitting on a fresh `Busy` status, with one other status
 *  to move to. */
export const arrangeBusy = async (): Promise<{
  busyId: number;
  attendeeId: number;
  otherId: number;
}> => {
  const otherId = await create("Landing Status");
  const busyId = await create("Busy");
  const { attendee } = await setupListingAndAttendee({ name: "Holder" });
  await execute(
    sql`UPDATE attendees SET status_id = ${busyId} WHERE id = ${attendee.id}`,
  );
  return { attendeeId: attendee.id, busyId, otherId };
};
