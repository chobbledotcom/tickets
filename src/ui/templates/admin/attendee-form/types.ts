import type {
  BalanceNotice,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import type { AttendeeLogisticsData } from "#routes/admin/attendee-logistics.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { SelectedQuestionAnswers } from "#shared/db/question-types.ts";
import type { Attendee } from "#shared/types.ts";

/** Everything the editable attendee form needs to render. */
export interface AttendeeFormTemplateData extends SelectedQuestionAnswers {
  attendee: Attendee | null;
  attendeeError: string | null;
  balanceNotice: BalanceNotice | null;
  dateError: string | null;
  formError: string | null;
  hasDailyListings: boolean;
  hasMixedTimings: boolean;
  lineWarnings: Map<number, string[]>;
  logistics?: AttendeeLogisticsData | undefined;
  mode: "create" | "edit";
  packageNamesById: Map<number, string>;
  parentNamesById: Map<number, string>;
  parsed: ParsedAttendeeForm;
  returnUrl?: string | undefined;
  saveError?: string | undefined;
  statuses: AttendeeStatus[];
  topWarnings: string[];
}

export type AttendeeFormProps = { data: AttendeeFormTemplateData };
