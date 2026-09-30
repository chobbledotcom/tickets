import { getDb } from "#db/client.ts";
import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-09-30_checked_in_count",
  "checked_in becomes a count of admitted tickets, 0..quantity, instead of " +
    "a 0/1 flag. A line an operator marked as arrived held its full quantity " +
    "in practice, because the flag could not record less, so every stored 1 " +
    "becomes the row's quantity. Ghost rows (quantity 0) and never-checked " +
    "rows keep 0. It runs before this build serves a request, so every " +
    "stored 1 it reads is still a flag. The count writers and readers land " +
    "in the same build, so nothing reads a count as a flag.",
  async () => {
    await getDb().execute(
      `UPDATE listing_attendees
       SET checked_in = CASE WHEN quantity > 0 THEN quantity ELSE 0 END
       WHERE checked_in = 1`,
    );
  },
);
