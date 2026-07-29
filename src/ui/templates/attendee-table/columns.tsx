import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import { normalizePhone } from "#shared/phone.ts";
import { requireValue } from "#shared/required-value.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import {
  type AttendeeColumnKey,
  configurableTableLayouts,
} from "#shared/tables/configurable.ts";
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

const attendeeColumnText = tableColumnText("admin.attendee_table.column");

const name: AttendeeRenderer = {
  ...attendeeColumnText("name"),
  cell: (row, options) =>
    options.adminLinks ? (
      <a href={attendeeAdminPath(row.attendee)}>{row.attendee.name}</a>
    ) : (
      row.attendee.name
    ),
};

const listings: AttendeeRenderer = {
  ...attendeeColumnText("listings"),
  cell: (row, options) => {
    const links = row.listings.map((listing, index) => (
      <>
        {index > 0 && ", "}
        {options.adminLinks ? (
          <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>
        ) : (
          listing.name
        )}
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
  ...attendeeColumnText("date"),
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  rawValue: (row) => row.attendee.date || "",
};

const email: AttendeeRenderer = {
  ...attendeeColumnText("email"),
  cell: (row) => row.attendee.email || "",
};

const phone: AttendeeRenderer = {
  ...attendeeColumnText("phone"),
  cell: (row, options) => {
    if (!row.attendee.phone) return "";
    const normalized = normalizePhone(row.attendee.phone, options.phonePrefix);
    return <a href={`tel:${normalized}`}>{row.attendee.phone}</a>;
  },
};

const address: AttendeeRenderer = {
  ...attendeeColumnText("address"),
  cell: (row) => formatAddressInline(row.attendee.address || ""),
};

const special_instructions: AttendeeRenderer = {
  ...attendeeColumnText("special_instructions"),
  cell: (row) =>
    formatInstructionsInline(row.attendee.special_instructions || ""),
};

const answers: AttendeeRenderer = {
  ...attendeeColumnText("answers"),
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
  ...attendeeColumnText("qty"),
  cell: (row) => String(row.attendee.quantity),
  class: "quantity",
};

const ticket: AttendeeRenderer = {
  ...attendeeColumnText("ticket"),
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
  ...attendeeColumnText("registered"),
  cell: (row) => formatDatetimeShort(row.attendee.created),
  rawValue: (row) => row.attendee.created,
};

const status: AttendeeRenderer = {
  ...attendeeColumnText("status"),
  cell: (row, options) => options.renderStatus(row),
  className: "actions-col",
  header: "",
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
