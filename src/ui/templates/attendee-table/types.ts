import type { AttendeeQuestionData } from "#db/questions/attendee-answers/reads.ts";
import type { Child } from "#jsx/jsx-runtime.ts";
import type { AttendeeColumnKey } from "#shared/tables/configurable.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import type { AttendeeTableRow } from "#types";

export type { AttendeeQuestionData };

/** Values shared by attendee column renderers during one table render. */
export type AttendeeColumnOpts = {
  adminLinks: boolean;
  allowedDomain: string;
  phonePrefix: string;
  renderStatus: (row: AttendeeTableRow) => Child;
  answerTextMap: Map<number, string>;
  answerQuestionMap: Map<number, string>;
  questionData?: AttendeeQuestionData | undefined;
};

/** Options for the unified attendee table. */
export type AttendeeTableOptions = {
  rows: AttendeeTableRow[];
  allowedDomain: string;
  /** Link attendee/listing cells to staff-only admin pages (default: true). */
  adminLinks?: boolean | undefined;
  showListing: boolean;
  showDate: boolean;
  activeFilter?: string | undefined;
  returnUrl?: string | undefined;
  emptyMessage?: string | undefined;
  phonePrefix?: string | undefined;
  /** Show the check-in/check-out status column (default: true). */
  showCheckin?: boolean | undefined;
  /** Skip default sort and use rows as-is (default: false). */
  presorted?: boolean | undefined;
  questionData?: AttendeeQuestionData | undefined;
  columnLayout?: TableLayout<AttendeeColumnKey> | undefined;
};
