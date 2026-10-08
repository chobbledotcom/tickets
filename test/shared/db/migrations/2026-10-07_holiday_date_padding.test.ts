/** The holiday date padding migration: unpadded stored dates are padded once,
 *  a value the strict rule still refuses stops the migration loudly. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, resultRows } from "#db/client.ts";
import holidayDatePaddingMigration from "#db/migrations/2026-10-07_holiday_date_padding.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
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

describeWithEnv("holiday date padding migration", { db: true }, () => {
  test("pads unpadded stored dates and leaves strict ones", async () => {
    await insertHoliday("Padded Party", "2027-06-01", "2027-06-02");
    await insertHoliday("Unpadded Party", "2027-6-1", "2027-6-2");

    await holidayDatePaddingMigration(buildMigrationContext()).up();

    const rows = await holidayRows();
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("Unpadded Party")).toMatchObject({
      end_date: "2027-06-02",
      start_date: "2027-06-01",
    });
    expect(byName.get("Padded Party")).toMatchObject({
      end_date: "2027-06-02",
      start_date: "2027-06-01",
    });
  });

  test("refuses garbage dates without repairing them", async () => {
    await insertHoliday("Broken Party", "not-a-date", "also-not-a-date");
    await insertHoliday("Strict Party", "2027-06-01", "2027-06-02");

    await expect(
      holidayDatePaddingMigration(buildMigrationContext()).up(),
    ).rejects.toThrow(
      "the holiday start_date does not hold a usable date: not-a-date",
    );

    const rows = await holidayRows();
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("Broken Party")).toMatchObject({
      end_date: "also-not-a-date",
      start_date: "not-a-date",
    });
    expect(byName.get("Strict Party")).toMatchObject({
      end_date: "2027-06-02",
      start_date: "2027-06-01",
    });
  });

  test("refuses a padded date no padding can repair", async () => {
    await insertHoliday("Impossible Party", "2027-02-30", "2027-06-02");

    await expect(
      holidayDatePaddingMigration(buildMigrationContext()).up(),
    ).rejects.toThrow(
      "the holiday start_date does not hold a usable date: 2027-02-30",
    );
  });

  test("refuses an unpadded date whose padded form is invalid", async () => {
    await insertHoliday("Unpadded Impossible Party", "2027-2-30", "2027-06-02");

    await expect(
      holidayDatePaddingMigration(buildMigrationContext()).up(),
    ).rejects.toThrow(
      "the holiday start_date does not hold a usable date: 2027-02-30",
    );
  });

  test("refuses a garbage end date the same way", async () => {
    await insertHoliday("Broken End Party", "2027-06-01", "also-not-a-date");
    await expect(
      holidayDatePaddingMigration(buildMigrationContext()).up(),
    ).rejects.toThrow(
      "the holiday end_date does not hold a usable date: also-not-a-date",
    );
  });

  test("pads twenty rows inside one request's migration budget", async () => {
    for (let i = 0; i < 20; i++) {
      await insertHoliday(`Crowd ${i}`, "2027-6-1", "2027-6-2");
    }

    await runWithSubrequestBudget(() =>
      withSubrequestAllowance(
        {
          database: 45,
          external: BUNNY_SUBREQUEST_LIMIT,
          total: 45,
        },
        () => holidayDatePaddingMigration(buildMigrationContext()).up(),
      ),
    );

    const rows = await holidayRows();
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.start_date === "2027-06-01")).toBe(true);
    expect(rows.every((row) => row.end_date === "2027-06-02")).toBe(true);
  });
});
