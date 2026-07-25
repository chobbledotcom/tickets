/** Public attendee-table surface. Implementation lives in focused modules. */

export type { AttendeeTableRow } from "#shared/types.ts";
export { attendeeTable } from "#templates/attendee-table/columns.tsx";
export { AttendeeTable } from "#templates/attendee-table/component.tsx";
export type {
  AttendeeColumnOpts,
  AttendeeTableOptions,
  TableQuestionData,
} from "#templates/attendee-table/types.ts";
export {
  formatAddressInline,
  sortAttendeeRows,
} from "#templates/attendee-table/values.ts";
