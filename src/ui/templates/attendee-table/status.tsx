import { remainingTickets } from "#booking/remaining-tickets.ts";
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

/** What one roster line's check-in controls read. */
type CheckinControlsProps = {
  attendee: DisplayAttendee;
  listingId: number;
  activeFilter: string;
  returnUrl: string | undefined;
};

/** The quantity page's URL, with the roster's return link threaded on so
 * the page lands the operator back on the view they came from. */
const checkinPageHref = (
  attendee: DisplayAttendee,
  listingId: number,
  activeFilter: string,
  returnUrl: string | undefined,
): string => {
  const href = `/admin/listing/${listingId}/attendee/${attendee.id}/checkin`;
  const params = new URLSearchParams();
  if (returnUrl) params.set("return_url", returnUrl);
  if (activeFilter !== "all") params.set("return_filter", activeFilter);
  const query = params.toString();
  return query ? `${href}?${query}` : href;
};

/** One roster line's check-in controls. A quantity 1 line keeps the direct
 * toggle — one POST, no page between the roster and the answer — which is
 * the journey the roster Feature pins. A line that holds more than one
 * ticket links to the quantity page instead, one link per direction the
 * line still allows, so a part booking can admit the rest or release what
 * it holds. */
const CheckinControls = ({
  attendee,
  listingId,
  activeFilter,
  returnUrl,
}: CheckinControlsProps): JSX.Element => {
  if (attendee.quantity > 1) {
    const href = checkinPageHref(attendee, listingId, activeFilter, returnUrl);
    return (
      <span class="checkin-links">
        {remainingTickets(attendee) > 0 ? (
          <a class="link-button checkin" href={href}>
            {t("admin.attendee_table.check_in")}
          </a>
        ) : undefined}
        {attendee.checked_in > 0 ? (
          <a class="link-button checkout" href={href}>
            {t("admin.attendee_table.check_out")}
          </a>
        ) : undefined}
      </span>
    );
  }
  const out = attendee.checked_in > 0;
  return (
    <CsrfForm
      action={`/admin/listing/${listingId}/attendee/${attendee.id}/checkin`}
      class="inline"
    >
      <input name="check_in" type="hidden" value={out ? "false" : "true"} />
      <input name="return_filter" type="hidden" value={activeFilter} />
      <ReturnUrlField returnUrl={returnUrl} />
      <button
        class={out ? "link-button checkout" : "link-button checkin"}
        type="submit"
      >
        {out
          ? t("admin.attendee_table.check_out")
          : t("admin.attendee_table.check_in")}
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
    return CheckinControls({
      activeFilter: options.activeFilter ?? "all",
      attendee,
      listingId: requireValue(
        row.listings[0],
        `Attendee ${attendee.id} has no listing`,
      ).id,
      returnUrl: options.returnUrl,
    });
  };
