import type { Child } from "#shared/jsx/jsx-runtime.ts";
import {
  AttendeeTable,
  type AttendeeTableOptions,
} from "#templates/attendee-table.tsx";

type SharedAttendeeTableOptions = Pick<
  AttendeeTableOptions,
  "allowedDomain" | "rows" | "showDate" | "showListing"
> &
  Partial<
    Pick<
      AttendeeTableOptions,
      "activeFilter" | "phonePrefix" | "questionData" | "returnUrl"
    >
  >;

export const attendeeTableOptions = (
  options: SharedAttendeeTableOptions,
): AttendeeTableOptions => options;

export const AttendeeTableBlock = ({
  actions,
  options,
}: {
  actions?: Child;
  options: AttendeeTableOptions;
}): JSX.Element => (
  <>
    {AttendeeTable(options)}
    {actions && <div class="table-actions">{actions}</div>}
  </>
);
