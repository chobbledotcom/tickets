import type { HolidayInput } from "#shared/db/holidays.ts";
import type { Holiday } from "#shared/types.ts";
import { doAuthenticatedFormRequest } from "./request.ts";

export const createTestHoliday = (
  overrides: Partial<HolidayInput> = {},
): Promise<Holiday> => {
  const input: HolidayInput = {
    endDate: overrides.endDate ?? "2026-12-25",
    name: overrides.name ?? "Test Holiday",
    startDate: overrides.startDate ?? "2026-12-25",
  };

  return doAuthenticatedFormRequest(
    "/admin/holidays",
    {
      end_date: input.endDate,
      name: input.name,
      start_date: input.startDate,
    },
    async () => {
      const { getAllHolidays } = await import("#shared/db/holidays.ts");
      const holidays = await getAllHolidays();
      return holidays[holidays.length - 1] as Holiday;
    },
    "create holiday",
  );
};

export const updateTestHoliday = async (
  holidayId: number,
  updates: Partial<HolidayInput>,
): Promise<Holiday> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      end_date: updates.endDate ?? existing.end_date,
      name: updates.name ?? existing.name,
      start_date: updates.startDate ?? existing.start_date,
    },
    async () => {
      const updated = await holidaysTable.findById(holidayId);
      return updated as Holiday;
    },
    "update holiday",
  );
};

export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete holiday",
  );
};
