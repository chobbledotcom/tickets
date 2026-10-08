import {
  executeBatchWithoutCacheInvalidation,
  queryAllPrimary,
} from "#db/client.ts";
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
    // Validate every row before writing anything, then write the repairs as
    // one batch: one transaction per row costs three round-trips each, which
    // a twenty-row table cannot fit in one request's migration budget.
    const updates = rows.flatMap((row) => {
      // An unpadded value pads; an already-padded value stays as it is; the
      // strict rule then decides, and a value it refuses stops the run.
      const startDate = parseDateStringOrThrow(
        padLegacyDateParts(row.start_date) ?? row.start_date,
        "the holiday start_date",
      );
      const endDate = parseDateStringOrThrow(
        padLegacyDateParts(row.end_date) ?? row.end_date,
        "the holiday end_date",
      );
      if (startDate === row.start_date && endDate === row.end_date) return [];
      return [
        {
          args: [startDate, endDate, row.id],
          sql: "UPDATE holidays SET start_date = ?, end_date = ? WHERE id = ?",
        },
      ];
    });
    await executeBatchWithoutCacheInvalidation(updates);
  },
);
