import { remainingTickets } from "#booking/remaining-tickets.ts";
import type { PairBooking } from "#booking/ticket-moves.ts";
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
  /** The whole booking this line belongs to on its listing. */
  booking: PairBooking;
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

/** How far a booking of several places has got through the door. */
type PartyState = "none_in" | "some_in" | "all_in";

const partyState = (booking: PairBooking): PartyState => {
  if (booking.checked_in === 0) return "none_in";
  return remainingTickets(booking) > 0 ? "some_in" : "all_in";
};

/** The one link a booking of several places shows. It always opens the page
 * that asks how many, so a part-admitted party reads "Check in/out" rather
 * than two links for the same page. */
const PARTY_LINKS: Record<
  PartyState,
  { labelKey: string; tone: "checkin" | "checkout" }
> = {
  all_in: { labelKey: "admin.attendee_table.check_out", tone: "checkout" },
  none_in: { labelKey: "admin.attendee_table.check_in", tone: "checkin" },
  some_in: { labelKey: "admin.attendee_table.check_in_out", tone: "checkin" },
};

/** One roster line's check-in controls. A booking of one ticket keeps the
 * direct toggle, one POST with no page between the roster and the answer,
 * which is the journey the roster Feature pins. A larger booking links to the
 * quantity page instead, one link per direction it still allows. */
const CheckinControls = ({
  attendee,
  booking,
  listingId,
  activeFilter,
  returnUrl,
}: CheckinControlsProps): JSX.Element => {
  // The write spreads a count over all the pair's lines, so the control is
  // picked from the whole booking: a booking of one ticket keeps the direct
  // toggle, a larger booking links to the quantity page.
  if (booking.quantity > 1) {
    const href = checkinPageHref(attendee, listingId, activeFilter, returnUrl);
    const { labelKey, tone } = PARTY_LINKS[partyState(booking)];
    return (
      <a class={`link-button ${tone}`} href={href}>
        {t(labelKey)}
      </a>
    );
  }
  const out = booking.checked_in > 0;
  return (
    <CsrfForm
      action={`/admin/listing/${listingId}/attendee/${attendee.id}/checkin`}
      class="inline"
    >
      <input name="check_in" type="hidden" value={out ? "false" : "true"} />
      <input name="quantity" type="hidden" value="1" />
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

/** The read-only state badge shown when the toggle form is refused. It
 * reads the whole booking, so a part-admitted party shows how many are in. */
const checkinStateBadge = (booking: PairBooking): JSX.Element => {
  if (booking.checked_in === 0) {
    return (
      <span class="muted small">
        {t("admin.attendee_table.not_checked_in_badge")}
      </span>
    );
  }
  return remainingTickets(booking) > 0 ? (
    <Badge variant="ok">
      {t("attendee_form.checked_in_count", {
        count: booking.checked_in,
        total: booking.quantity,
      })}
    </Badge>
  ) : (
    <Badge variant="ok">{t("admin.attendee_table.checked_in_badge")}</Badge>
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
    const booking = requireValue(
      row.booking,
      `Attendee ${attendee.id} has no booking read`,
    );
    if (options.showCheckinState && options.showCheckin === false) {
      return checkinStateBadge(booking);
    }
    return CheckinControls({
      activeFilter: options.activeFilter ?? "all",
      attendee,
      booking,
      listingId: requireValue(
        row.listings[0],
        `Attendee ${attendee.id} has no listing`,
      ).id,
      returnUrl: options.returnUrl,
    });
  };
