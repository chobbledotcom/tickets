import { queryAllPrimary, withTransaction } from "#db/client.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { bareSchemaMigration } from "./define.ts";

/** The unpadded-ISO repair: "2027-6-1" names June the first. */
const padLegacyDateParts = (raw: string): string | null => {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  return parts === null
    ? null
    : `${parts[1]}-${parts[2]!.padStart(2, "0")}-${parts[3]!.padStart(2, "0")}`;
};

/** Pad the stored holiday start_date and end_date values that match the
 *  unpadded shape. A value the strict rule still refuses after the padding
 *  stops the migration loudly: the repair must not guess, and the admin
 *  repairs the data explicitly. */
export default bareSchemaMigration(
  "2026-10-07_holiday_date_padding",
  "Pad the stored holiday dates the pre-2476 mapper wrote unpadded.",
  async () => {
    const rows = await queryAllPrimary<{
      end_date: string;
      id: number;
      start_date: string;
    }>({
      args: [],
      sql: "SELECT id, start_date, end_date FROM holidays",
    });
    for (const row of rows) {
      // An unpadded value pads; a value that is already strict stays as it
      // is; anything else is an impossible stored state and stops the run.
      const startDate =
        padLegacyDateParts(row.start_date) ??
        parseDateStringOrThrow(row.start_date, "the holiday start_date");
      const endDate =
        padLegacyDateParts(row.end_date) ??
        parseDateStringOrThrow(row.end_date, "the holiday end_date");
      if (startDate === row.start_date && endDate === row.end_date) continue;
      await withTransaction(async (tx) => {
        await tx.execute({
          args: [startDate, endDate, row.id],
          sql: "UPDATE holidays SET start_date = ?, end_date = ? WHERE id = ?",
        });
      });
    }
  },
);
