/** Factories for the attendee form's lines. */

import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** One attendee-form line booking listing 1, overridable per test. */
export const attendeeFormLine = (
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
  quantity: null,
  ...overrides,
});
