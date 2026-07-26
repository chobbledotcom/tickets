import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import { normalizePhone } from "#shared/phone.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type AttendeeColumnKey,
  configurableTableLayouts,
} from "#shared/tables/configurable.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { attachTableRenderers } from "#shared/tables/definition.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";
import { noQuantityIndicator } from "#templates/attendee-table/status.tsx";
import type { AttendeeColumnOpts } from "#templates/attendee-table/types.ts";
import {
  formatAddressInline,
  formatInstructionsInline,
  getAnswerDisplay,
} from "#templates/attendee-table/values.ts";
import { tableColumnText } from "#templates/components/table.tsx";

type AttendeeRenderer = Omit<
  TableColumn<AttendeeTableRow, AttendeeColumnOpts, AttendeeColumnKey>,
  "key"
>;

const name: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.name.label"),
    () => t("admin.attendee_table.column.name.description"),
  ),
  cell: (row) => (
    <a href={attendeeAdminPath(row.attendee)}>{row.attendee.name}</a>
  ),
};

const listings: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.listings.label"),
    () => t("admin.attendee_table.column.listings.description"),
  ),
  cell: (row) => {
    const links = row.listings.map((listing, index) => (
      <>
        {index > 0 && ", "}
        <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
      </>
    ));
    const fullList = row.listings.map((listing) => listing.name).join(", ");
    return (
      <span class="listings-cell" title={fullList}>
        {links}
      </span>
    );
  },
};

const date: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.date.label"),
    () => t("admin.attendee_table.column.date.description"),
  ),
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  rawValue: (row) => row.attendee.date || "",
};

const email: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.email.label"),
    () => t("admin.attendee_table.column.email.description"),
  ),
  cell: (row) => row.attendee.email || "",
};

const phone: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.phone.label"),
    () => t("admin.attendee_table.column.phone.description"),
  ),
  cell: (row, options) => {
    if (!row.attendee.phone) return "";
    const normalized = normalizePhone(row.attendee.phone, options.phonePrefix);
    return <a href={`tel:${normalized}`}>{row.attendee.phone}</a>;
  },
};

const address: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.address.label"),
    () => t("admin.attendee_table.column.address.description"),
  ),
  cell: (row) => formatAddressInline(row.attendee.address || ""),
};

const special_instructions: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.special_instructions.label"),
    () => t("admin.attendee_table.column.special_instructions.description"),
  ),
  cell: (row) =>
    formatInstructionsInline(row.attendee.special_instructions || ""),
};

const answers: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.answers.label"),
    () => t("admin.attendee_table.column.answers.description"),
  ),
  cell: (row, options) => {
    const { short, tooltip } = getAnswerDisplay(
      row.attendee.id,
      requireValue(
        options.questionData,
        "Answers column requires question data",
      ),
      options.answerTextMap,
      options.answerQuestionMap,
    );
    return <span title={tooltip}>{short}</span>;
  },
  className: "answers-cell",
};

const qty: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.qty.label"),
    () => t("admin.attendee_table.column.qty.description"),
  ),
  cell: (row) => String(row.attendee.quantity),
  class: "quantity",
};

const ticket: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.ticket.label"),
    () => t("admin.attendee_table.column.ticket.description"),
  ),
  cell: (row, options) => {
    if (isServicing(row.attendee.kind)) {
      return (
        <span class="muted small">{t("admin.attendee_table.servicing")}</span>
      );
    }
    if (!hasTicketQuantity(row.attendee)) return noQuantityIndicator();
    return (
      <a
        href={`https://${options.allowedDomain}/t/${row.attendee.ticket_token}`}
      >
        {row.attendee.ticket_token}
      </a>
    );
  },
};

const registered: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.registered.label"),
    () => t("admin.attendee_table.column.registered.description"),
  ),
  cell: (row) => formatDatetimeShort(row.attendee.created),
  rawValue: (row) => row.attendee.created,
};

const status: AttendeeRenderer = {
  ...tableColumnText(
    () => t("admin.attendee_table.column.status.label"),
    () => t("admin.attendee_table.column.status.description"),
    () => "",
  ),
  cell: (row, options) => options.renderStatus(row),
  className: "actions-col",
  headerClassName: "actions-col",
};

/** Every attendee column attached to the one configurable attendee layout. */
export const attendeeTable = attachTableRenderers<
  AttendeeTableRow,
  AttendeeColumnOpts,
  AttendeeColumnKey
>(configurableTableLayouts.attendee, {
  address,
  answers,
  date,
  email,
  listings,
  name,
  phone,
  qty,
  registered,
  special_instructions,
  status,
  ticket,
});
