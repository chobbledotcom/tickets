import { isServicing } from "#db/attendees/kind.ts";
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { requireValue } from "#shared/required-value.ts";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
import type { AttendeeTableOptions } from "#templates/attendee-table/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import {
  type AttendeeTableRow,
  type DisplayAttendee,
  hasTicketQuantity,
} from "#types";

/** A no-quantity row has no live customer ticket and cannot be checked in. */
export const noQuantityIndicator = (): JSX.Element => (
  <span class="muted small">{t("admin.attendee_table.no_quantity")}</span>
);

const CheckinButton = ({
  attendee,
  listingId,
  activeFilter,
  returnUrl,
}: {
  attendee: DisplayAttendee;
  listingId: number;
  activeFilter: string;
  returnUrl: string | undefined;
}): JSX.Element => {
  const label = attendee.checked_in
    ? t("admin.attendee_table.check_out")
    : t("admin.attendee_table.check_in");
  const buttonClass = attendee.checked_in
    ? "link-button checkout"
    : "link-button checkin";
  return (
    <CsrfForm
      action={`/admin/listing/${listingId}/attendee/${attendee.id}/checkin`}
      class="inline"
    >
      <input name="return_filter" type="hidden" value={activeFilter} />
      <ReturnUrlField returnUrl={returnUrl} />
      <button class={buttonClass} type="submit">
        {label}
      </button>
    </CsrfForm>
  );
};

/** Build the status-cell renderer for one attendee table. */
export const createStatusRenderer =
  (options: AttendeeTableOptions): ((row: AttendeeTableRow) => JSX.Element) =>
  (row) => {
    const attendee = row.attendee;
    if (isServicing(attendee.kind)) {
      return (
        <span class="servicing-event" data-servicing="true">
          {t("admin.attendee_table.servicing")}
        </span>
      );
    }
    if (!hasTicketQuantity(attendee)) return noQuantityIndicator();
    if (attendee.refunded) {
      return (
        <Badge variant="alert">
          {t("admin.attendee_table.refunded_badge")}
        </Badge>
      );
    }
    return CheckinButton({
      activeFilter: options.activeFilter ?? "all",
      attendee,
      listingId: requireValue(
        row.listings[0],
        `Attendee ${attendee.id} has no listing`,
      ).id,
      returnUrl: options.returnUrl,
    });
  };
