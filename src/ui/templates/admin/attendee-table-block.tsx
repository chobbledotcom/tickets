import type { Child } from "#jsx/jsx-runtime.ts";
import { AttendeeTable } from "#templates/attendee-table/component.tsx";
import type { AttendeeTableOptions } from "#templates/attendee-table/types.ts";

type SharedAttendeeTableOptions = Pick<
  AttendeeTableOptions,
  "allowedDomain" | "rows" | "showDate" | "showListing"
> &
  Partial<
    Pick<
      AttendeeTableOptions,
      | "activeFilter"
      | "adminLinks"
      | "phonePrefix"
      | "presorted"
      | "questionData"
      | "returnUrl"
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
