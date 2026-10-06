/** Fixture builders shared by the attendee-form sibling tests. */

import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";

export const formData = (
  parsed: AttendeeFormTemplateData["parsed"],
  overrides: Partial<AttendeeFormTemplateData> = {},
): AttendeeFormTemplateData => ({
  atBooking: [],
  attendee: null,
  attendeeError: null,
  balanceNotice: null,
  dateError: null,
  formError: null,
  hasDailyListings: false,
  hasMixedTimings: false,
  lineWarnings: new Map(),
  mode: "create",
  packageNamesById: new Map([[10, "Weekend pass"]]),
  parentNamesById: new Map([[20, "Main tour"]]),
  parsed,
  questions: [],
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
  statuses: [],
  topWarnings: [],
  ...overrides,
});
