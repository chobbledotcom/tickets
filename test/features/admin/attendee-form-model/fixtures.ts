import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { FormParams } from "#shared/form-data.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

export const makeForm = (data: Record<string, string>): FormParams =>
  new FormParams(new URLSearchParams(data));

export const line = (
  overrides: Partial<AttendeeFormLine> = {},
): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing: testListingWithCount({ id: 1, max_quantity: 5 }),
  listingId: 1,
  noQuantity: false,
  packageGroupId: 0,
  packagePrice: null,
  parentListingId: 0,
  quantity: 1,
  ...overrides,
});

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
