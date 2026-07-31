import { t } from "#i18n";
import { isServicing } from "#shared/db/attendees/kind.ts";
import { settings } from "#shared/db/settings.ts";
import type { AttendeeColumnKey } from "#shared/tables/configurable.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import { attendeeTable } from "#templates/attendee-table/columns.tsx";
import { createStatusRenderer } from "#templates/attendee-table/status.tsx";
import type {
  AttendeeColumnOpts,
  AttendeeTableOptions,
} from "#templates/attendee-table/types.ts";
import {
  buildAnswerMaps,
  hiddenAttendeeColumnKeys,
  sortAttendeeRows,
} from "#templates/attendee-table/values.ts";
import { renderTable } from "#templates/components/table.tsx";

const buildColumnOptions = (
  options: AttendeeTableOptions,
): AttendeeColumnOpts => {
  const questionData =
    options.questionData && options.questionData.questions.length > 0
      ? options.questionData
      : undefined;
  const answerMaps = buildAnswerMaps(questionData?.questions ?? []);
  return {
    adminLinks: options.adminLinks ?? true,
    allowedDomain: options.allowedDomain,
    ...answerMaps,
    phonePrefix: options.phonePrefix || "44",
    questionData,
    renderStatus: createStatusRenderer(options),
  };
};

/** Render the unified attendee table. */
export const AttendeeTable = (options: AttendeeTableOptions): JSX.Element => {
  const rows = options.presorted
    ? options.rows
    : sortAttendeeRows(options.rows);
  const layout: TableLayout<AttendeeColumnKey> =
    options.columnLayout ?? settings.attendeeColumnLayout;
  return renderTable(attendeeTable, rows, {
    columnKeys: layout.columnKeys,
    context: buildColumnOptions(options),
    empty: options.emptyMessage ?? t("admin.attendee_table.no_attendees"),
    filters: layout.filters,
    hiddenKeys: hiddenAttendeeColumnKeys(rows, options),
    rowAttrs: (row) =>
      isServicing(row.attendee.kind)
        ? { class: "servicing-event", "data-servicing": "true" }
        : {},
  });
};
