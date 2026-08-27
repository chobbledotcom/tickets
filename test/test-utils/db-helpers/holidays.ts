import type { HolidayInput } from "#db/holidays.ts";
import type { Holiday } from "#types";
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
      const { holidays } = await import("#db/holidays.ts");
      const all = await holidays.getAll();
      return all[all.length - 1] as Holiday;
    },
    "create holiday",
  );
};

/** The holiday as it is stored now. Editing and deleting both need it: the
 * edit form re-sends the fields it does not change, and the delete form
 * confirms by name. */
const storedHoliday = async (holidayId: number): Promise<Holiday> => {
  const { holidays } = await import("#db/holidays.ts");
  return (await holidays.table.read.one({ id: holidayId })) as Holiday;
};

export const updateTestHoliday = async (
  holidayId: number,
  updates: Partial<HolidayInput>,
): Promise<Holiday> => {
  const existing = await storedHoliday(holidayId);

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      end_date: updates.endDate ?? existing.end_date,
      name: updates.name ?? existing.name,
      start_date: updates.startDate ?? existing.start_date,
    },
    () => storedHoliday(holidayId),
    "update holiday",
  );
};

export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const existing = await storedHoliday(holidayId);

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete holiday",
  );
};
