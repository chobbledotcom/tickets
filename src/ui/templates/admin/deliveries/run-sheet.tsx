/**
 * The run sheet's editable day rendering.
 *
 * One day of the run sheet is two Liquid templates the owner can rewrite: the
 * heading, and the body under it. The body receives the day's bookings and
 * their legs, already shaped for display.
 *
 * Values a person typed are escaped here, because the template is the owner's
 * own markup. The mark toggle and the map and phone links travel as ready-made
 * HTML, so a template never builds a form itself.
 */

import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { renderEditableTemplate } from "#shared/editable-template.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { DateString } from "#shared/validation/date-string.ts";
import {
  DEFAULT_RUN_SHEET_BODY,
  DEFAULT_RUN_SHEET_HEADING,
} from "#templates/admin/deliveries/run-sheet-defaults.ts";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";

/** A single drop-off or collection job within a booking on the run sheet. */
export type DeliveryLegView = {
  kind: "start" | "end";
  /** Name of the logistics agent (van/crew) this leg belongs to. */
  agentName: string;
  /** Calendar date of this leg (YYYY-MM-DD), matching the run-sheet day. */
  date: string;
  /** Logistics time label ("" when unset). */
  time: string;
  done: boolean;
};

/** One booking on the run sheet, with its jobs for the day grouped together.
 * A driver then sees the same listing's legs side by side, not as two
 * unrelated rows. A servicing event is a booking here too. It carries a name
 * and a listing, and its contact fields stay empty. */
export type DeliveryBookingView = {
  attendeeId: number;
  listingId: number;
  listingName: string;
  attendeeName: string;
  address: string;
  phone: string;
  /** The booking's ticket token — the id the customer can quote to confirm. */
  ticketToken: string;
  /** The jobs (drop-off and/or collection) for this booking on this day. */
  legs: DeliveryLegView[];
};

/** One run-sheet day: its calendar date and the bookings on it. */
export type DeliveryDayGroup = {
  date: DateString;
  bookings: DeliveryBookingView[];
};

/** A day ready to render: its heading and body, both from the templates. */
export type RunSheetDay = {
  heading: string;
  bodyHtml: string;
  /** True when the day has no bookings, so the page can say so once. */
  empty: boolean;
};

/** How a day sits against the real today, so a template can say "Today". */
type DayRelative = "today" | "tomorrow" | "other";

/** The labels a template reads, so wording comes from the message catalog
 * while the operator still controls the markup around it. */
type RunSheetLabels = {
  address: string;
  listing: string;
  name: string;
  nothing_scheduled: string;
  phone: string;
  today: string;
  token: string;
  tomorrow: string;
};

const runSheetLabels = (): RunSheetLabels => ({
  address: escapeHtml(t("deliveries.address_label")),
  listing: escapeHtml(t("deliveries.listing_label")),
  name: escapeHtml(t("deliveries.name_label")),
  nothing_scheduled: escapeHtml(t("deliveries.nothing_scheduled")),
  phone: escapeHtml(t("deliveries.phone_label")),
  today: escapeHtml(t("deliveries.today")),
  token: escapeHtml(t("deliveries.token_label")),
  tomorrow: escapeHtml(t("deliveries.tomorrow")),
});

type RunSheetLegData = {
  label: string;
  time: string;
  agent: string;
  done: boolean;
  mark_form: string;
};

type RunSheetBookingData = {
  name: string;
  listing: string;
  address: string;
  phone: string;
  token: string;
  maps_links: string;
  phone_links: string;
  legs: RunSheetLegData[];
};

/** The done toggle for one leg, as ready-made HTML. The template places it.
 * The form, its CSRF token, and the button wording stay the site's. */
const legMarkForm = (
  booking: DeliveryBookingView,
  leg: DeliveryLegView,
): string =>
  String(
    <CsrfForm action="/admin/deliveries/mark" class="delivery-mark inline">
      <input
        name="attendee_id"
        type="hidden"
        value={String(booking.attendeeId)}
      />
      <input
        name="listing_id"
        type="hidden"
        value={String(booking.listingId)}
      />
      <input name="kind" type="hidden" value={leg.kind} />
      <input name="date" type="hidden" value={leg.date} />
      <input name="done" type="hidden" value={leg.done ? "0" : "1"} />
      <button type="submit">
        {leg.done ? t("deliveries.mark_not_done") : t("deliveries.mark_done")}
      </button>
    </CsrfForm>,
  );

const legData = (
  booking: DeliveryBookingView,
  leg: DeliveryLegView,
): RunSheetLegData => ({
  agent: escapeHtml(leg.agentName),
  done: leg.done,
  label: escapeHtml(
    leg.kind === "start" ? t("deliveries.dropoff") : t("deliveries.collection"),
  ),
  mark_form: legMarkForm(booking, leg),
  time: escapeHtml(leg.time),
});

/** One booking's display data. Maps and phone links are the site's own
 * fragments. Every value the customer or the staff typed is escaped. */
const bookingData = (
  booking: DeliveryBookingView,
  phonePrefix: string,
): RunSheetBookingData => ({
  address: escapeHtml(booking.address),
  legs: booking.legs.map((leg) => legData(booking, leg)),
  listing: escapeHtml(booking.listingName),
  maps_links:
    booking.address === "" ? "" : String(<MapsLinks query={booking.address} />),
  name: escapeHtml(booking.attendeeName),
  phone: escapeHtml(booking.phone),
  phone_links:
    booking.phone === ""
      ? ""
      : String(<PhoneLinks phone={booking.phone} phonePrefix={phonePrefix} />),
  token: escapeHtml(booking.ticketToken),
});

export type RunSheetTemplates = {
  bodyTemplate: string;
  headingTemplate: string;
};

type RenderOptions = RunSheetTemplates & {
  /** Country dialling prefix for the phone links. */
  phonePrefix: string;
  /** The real today, so a day can read as Today or Tomorrow. */
  today: DateString;
};

const renderDay = async (
  group: DeliveryDayGroup,
  options: RenderOptions,
  labels: RunSheetLabels,
): Promise<RunSheetDay> => {
  const relative: DayRelative =
    group.date === options.today
      ? "today"
      : group.date === addDays(options.today, 1)
        ? "tomorrow"
        : "other";
  const dateLabel = escapeHtml(formatDateLabel(group.date));
  const day = {
    bookings: group.bookings.map((booking) =>
      bookingData(booking, options.phonePrefix),
    ),
    date: group.date,
    date_label: dateLabel,
    relative,
  };
  const [heading, bodyHtml] = await Promise.all([
    renderEditableTemplate(
      {
        defaultTemplate: DEFAULT_RUN_SHEET_HEADING,
        template: options.headingTemplate,
      },
      { date: group.date, date_label: dateLabel, labels, relative },
    ),
    renderEditableTemplate(
      {
        defaultTemplate: DEFAULT_RUN_SHEET_BODY,
        template: options.bodyTemplate,
      },
      { day, labels },
    ),
  ]);
  return { bodyHtml, empty: group.bookings.length === 0, heading };
};

/** Render every day of the run sheet through the owner's templates. */
export const renderRunSheetDays = (
  groups: readonly DeliveryDayGroup[],
  options: RenderOptions,
): Promise<RunSheetDay[]> => {
  const labels = runSheetLabels();
  return Promise.all(groups.map((group) => renderDay(group, options, labels)));
};
