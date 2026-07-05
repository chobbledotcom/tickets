import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
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

export const attendeeTableOptions = ({
  activeFilter,
  allowedDomain,
  phonePrefix,
  questionData,
  returnUrl,
  rows,
  showDate,
  showListing,
}: SharedAttendeeTableOptions): AttendeeTableOptions => ({
  activeFilter,
  allowedDomain,
  phonePrefix,
  questionData,
  returnUrl,
  rows,
  showDate,
  showListing,
});

export const AttendeeTableBlock = ({
  actions,
  options,
}: {
  actions?: Child;
  options: AttendeeTableOptions;
}): JSX.Element => (
  <>
    <div class="table-scroll">
      <Raw html={AttendeeTable(options)} />
    </div>
    {actions && <div class="table-actions">{actions}</div>}
  </>
);
