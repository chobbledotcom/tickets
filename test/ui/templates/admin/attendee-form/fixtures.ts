/** Fixture builders shared by the attendee-form sibling tests. */

import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import type { ParsedAttendeeForm } from "#routes/admin/attendee-form-model.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import { attendeeFormLine } from "#test-utils/attendee-form-factories.ts";

export const parsed = (
  overrides: Partial<ParsedAttendeeForm> = {},
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: [attendeeFormLine()],
  name: "Test",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
  ...overrides,
});

export const statuses = (): AttendeeStatus[] => [
  {
    id: 4,
    // The public default is not the paid default, so a mutant that resolves
    // the selection with the wrong flag cannot pass.
    is_paid_default: false,
    is_public_default: true,
    is_reservation: false,
    name: "Confirmed",
    reservation_amount: "0",
    sort_order: 1,
  },
  {
    id: 9,
    is_paid_default: true,
    is_public_default: false,
    is_reservation: false,
    name: "Cancelled",
    reservation_amount: "0",
    sort_order: 2,
  },
];

export const data = (
  overrides: Partial<AttendeeFormTemplateData> = {},
): AttendeeFormTemplateData =>
  formData(parsed(), {
    statuses: statuses(),
    ...overrides,
  });

export const question = (): QuestionWithAnswers => ({
  answers: [
    { active: true, id: 61, question_id: 6, sort_order: 1, text: "Vegan" },
    { active: true, id: 62, question_id: 6, sort_order: 2, text: "Standard" },
  ],
  display_type: "radio",
  id: 6,
  text: "Meal preference",
});

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
