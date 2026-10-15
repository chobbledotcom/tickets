import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getActiveHolidays, holidays } from "#db/holidays.ts";
import { settings } from "#db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { has } from "#test-utils/says.ts";

describeWithEnv("db > holidays", { db: true }, () => {
  test("keeps only holidays that have not finished", async () => {
    await createTestHoliday({
      endDate: "2020-01-01",
      name: "Long Gone",
      startDate: "2020-01-01",
    });

    expect(await getActiveHolidays()).toEqual([]);
  });

  test("counts a holiday that ends today as still active", async () => {
    // The filter reads end_date >= today: a holiday's last day is bookable.
    const today = todayInTz(settings.timezone);
    await createTestHoliday({
      endDate: today,
      name: "Final Day",
      startDate: today,
    });

    const active = await getActiveHolidays();
    has(
      active.map((holiday) => holiday.name),
      "Final Day",
    );
  });

  test("lists every stored holiday by start date", async () => {
    await createTestHoliday({
      endDate: "2020-01-01",
      name: "Long Gone",
      startDate: "2020-01-01",
    });
    await createTestHoliday({
      endDate: "2030-03-05",
      name: "Later Start",
      startDate: "2030-03-02",
    });
    await createTestHoliday({
      endDate: "2030-03-04",
      name: "Earlier Start",
      startDate: "2030-03-01",
    });

    // Added latest but dated earliest, so order must follow the dates, not
    // insertion.
    const stored = await holidays.getAll();
    expect(stored.map((holiday) => holiday.start_date)).toEqual([
      "2020-01-01",
      "2030-03-01",
      "2030-03-02",
    ]);
  });
});
