/** Answers for tickets that a booking line no longer books. A line that loses
 * tickets keeps their answers, so the operator can raise the quantity again
 * or delete them. */

import { execute } from "#db/client.ts";
import { type ReadByIds, rowsForIds } from "#db/rows-for-ids.ts";
import { sql, sqlList } from "#db/sql.ts";
import { mapBy } from "#fp";

type HiddenCountRow = { attendee_id: number; hidden: number };

/** How many hidden answers each attendee holds. An attendee with none is
 * absent. One indexed read for the whole list. */
export const countHiddenLineAnswers: ReadByIds<number> = async (attendeeIds) =>
  mapBy(
    "attendee_id",
    (row: HiddenCountRow) => row.hidden,
  )(
    await rowsForIds<HiddenCountRow>(
      attendeeIds,
      (idSlots) =>
        sql`SELECT attendee_answer.attendee_id, COUNT(*) AS hidden
           FROM attendee_answers AS attendee_answer
           INNER JOIN listing_attendees AS line
             ON line.id = attendee_answer.booking_row_id
          WHERE attendee_answer.attendee_id IN (${idSlots})
            AND attendee_answer.unit_index >= line.quantity
          GROUP BY attendee_answer.attendee_id`,
    ),
  );

/** Delete the answers among `answerIds` that are still hidden. The operator
 * saw these answers, so an answer that is booked again, or one that a later
 * edit hid, stays. */
export const deleteHiddenLineAnswers = async (
  attendeeId: number,
  answerIds: readonly number[],
): Promise<number> => {
  const deleted = await execute(
    sql`DELETE FROM attendee_answers AS attendee_answer
      WHERE attendee_answer.attendee_id = ${attendeeId}
        AND attendee_answer.id IN (${sqlList([...answerIds])})
        AND attendee_answer.unit_index >= (
          SELECT line.quantity FROM listing_attendees AS line
           WHERE line.id = attendee_answer.booking_row_id)`,
  );
  return deleted.rowsAffected;
};
