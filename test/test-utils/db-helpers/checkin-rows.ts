/** The check-in state stored for one attendee's booking rows. The door
 * surfaces write this one fact, and the suites assert it straight from the
 * table — the answer a door worker's actions leave behind. */
export const storedCheckinRows = async (
  attendeeId: number,
): Promise<Array<{ checked_in: number }>> => {
  const { queryAll } = await import("#db/client.ts");
  return await queryAll<{ checked_in: number }>(
    "SELECT checked_in FROM listing_attendees WHERE attendee_id = ?",
    [attendeeId],
  );
};
