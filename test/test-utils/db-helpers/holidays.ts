import type { Holiday, HolidayInput } from "#db/holidays.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { doAuthenticatedFormRequest } from "./request.ts";

/** A hand-built holiday row, for tests that sort or fold without a database. */
export const testHoliday = (overrides: Partial<Holiday> = {}): Holiday => ({
  endDate: "2026-12-25",
  id: 1,
  name: "Test Holiday",
  startDate: "2026-12-25",
  ...overrides,
});

/** The fixture takes the dates as the plain strings a caller writes. They
 *  parse through the shared rule before the input can carry them. */
export const createTestHoliday = (
  overrides: { endDate?: string; name?: string; startDate?: string } = {},
): Promise<Holiday> => {
  const input: HolidayInput = {
    endDate: parseDateStringOrThrow(
      overrides.endDate ?? "2026-12-25",
      "the test holiday end date",
    ),
    name: overrides.name ?? "Test Holiday",
    startDate: parseDateStringOrThrow(
      overrides.startDate ?? "2026-12-25",
      "the test holiday start date",
    ),
  };

  return doAuthenticatedFormRequest(
    "/admin/holidays",
    {
      endDate: input.endDate,
      name: input.name,
      startDate: input.startDate,
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
  const { records } = await import("#db/record-table.ts");
  return (await records.holidays.find(holidayId)) as Holiday;
};

export const updateTestHoliday = async (
  holidayId: number,
  updates: { endDate?: string; name?: string; startDate?: string },
): Promise<Holiday> => {
  const existing = await storedHoliday(holidayId);

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      endDate: updates.endDate ?? existing.endDate,
      name: updates.name ?? existing.name,
      startDate: updates.startDate ?? existing.startDate,
    },
    () => storedHoliday(holidayId),
    "update holiday",
  );
};

export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const existing = await storedHoliday(holidayId);

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirmIdentifier: existing.name },
    async () => {},
    "delete holiday",
  );
};
