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
  adjustments: [null, null, null],
  dayCount: 1,
  email: "",
  lines: [attendeeFormLine()],
  name: "Test",
  payments: [null, null, null],
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
    isPaidDefault: false,
    isPublicDefault: true,
    isReservation: false,
    name: "Confirmed",
    reservationAmount: "0",
    sortOrder: 1,
  },
  {
    id: 9,
    isPaidDefault: true,
    isPublicDefault: false,
    isReservation: false,
    name: "Cancelled",
    reservationAmount: "0",
    sortOrder: 2,
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
  answerLevel: "booking",
  answers: [
    { active: true, id: 61, questionId: 6, sortOrder: 1, text: "Vegan" },
    { active: true, id: 62, questionId: 6, sortOrder: 2, text: "Standard" },
  ],
  assignAll: false,
  displayType: "radio",
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
