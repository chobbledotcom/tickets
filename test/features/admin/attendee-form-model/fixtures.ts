import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { FormParams } from "#shared/form-data.ts";
import { attendeeFormLine } from "#test-utils/attendee-form-factories.ts";

export const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

export const line = (
  overrides: Partial<AttendeeFormLine> = {},
): AttendeeFormLine => attendeeFormLine({ quantity: 1, ...overrides });

export const parsedBase = (
  overrides: Partial<ParsedAttendeeForm> = {},
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: [],
  name: "Test",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
  ...overrides,
});
