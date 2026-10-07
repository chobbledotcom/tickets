/** The holiday date padding migration: unpadded stored dates are padded once,
 *  a value the strict rule still refuses stops the migration loudly. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, resultRows } from "#db/client.ts";
import holidayDatePaddingMigration from "#db/migrations/2026-10-07_holiday_date_padding.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

type HolidayRow = {
  end_date: string;
  id: number;
  name: string;
  start_date: string;
};

const holidayRows = async (): Promise<HolidayRow[]> =>
  resultRows(
    await getDb().execute(
      "SELECT id, name, start_date, end_date FROM holidays",
    ),
  );

const insertHoliday = async (
  name: string,
  startDate: string,
  endDate: string,
): Promise<void> => {
  await getDb().execute({
    args: [name, startDate, endDate],
    sql: "INSERT INTO holidays (name, start_date, end_date) VALUES (?, ?, ?)",
  });
};

const holidayIdByName = async (name: string): Promise<number> =>
  resultRows<{ id: number }>(
    await getDb().execute({
      args: [name],
      sql: "SELECT id FROM holidays WHERE name = ?",
    }),
  )[0]!.id;

describeWithEnv("holiday date padding migration", { db: true }, () => {
  test("pads unpadded stored dates, leaves strict ones, refuses garbage", async () => {
    await insertHoliday("Padded Party", "2027-06-01", "2027-06-02");
    await insertHoliday("Unpadded Party", "2027-6-1", "2027-6-2");
    await insertHoliday("Broken Party", "not-a-date", "also-not-a-date");
    const brokenId = await holidayIdByName("Broken Party");

    await expect(
      holidayDatePaddingMigration(buildMigrationContext()).up(),
    ).rejects.toThrow(
      "the holiday start_date does not hold a usable date: not-a-date",
    );

    const rows = await holidayRows();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(brokenId)?.start_date).toBe("not-a-date");
    const unpadded = rows.find((row) => row.name !== "Broken Party");
    expect(unpadded?.start_date).toBe("2027-06-01");
  });
});
