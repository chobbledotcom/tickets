/**
 * Shared rendering for service events: the edit link and date label used by
 * both the dashboard's upcoming list and the /admin/servicing table, plus the
 * dashboard's upcoming-events section itself.
 */

import type { ServicingEventSummary } from "#db/attendees/servicing.ts";
import { t } from "#i18n";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { WritableLink } from "#templates/admin/writable-only.tsx";
import { openSection } from "#templates/components/open-section.tsx";

/** A link that opens the service event's edit page, labelled with its name. */
export const ServicingEventEditLink = ({
  event,
}: {
  event: Pick<ServicingEventSummary, "id" | "name">;
}): JSX.Element => (
  <WritableLink href={adminPath("servicingEdit", { id: event.id })}>
    {event.name}
  </WritableLink>
);

/** The event's date as a short label, or blank when nothing is booked yet.
 * The label uses the app's deterministic formatter, not the runtime's locale. */
export const servicingEventDateLabel = (date: string | null): string =>
  date === null ? "" : formatDateLabel(date);

const upcomingServicingRow = (event: ServicingEventSummary): JSX.Element => {
  // One `<li>` per service event (not per booking line), so a multi-listing hold
  // appears once. The compact details carry the listing count rather than every
  // name — the listing names are listed in the `/admin/servicing` table.
  const listingCount = event.bookings.length;
  const details = [
    servicingEventDateLabel(event.date),
    t("admin.dashboard.service_event_listing_count", { count: listingCount }),
    `${event.totalQuantity}`,
  ].filter(Boolean);
  return (
    <li>
      <ServicingEventEditLink event={event} />{" "}
      <span class="muted">{details.join(" · ")}</span>
    </li>
  );
};

/** The dashboard's upcoming service events, one line per event. */
export const upcomingServicingSection = (
  events: ServicingEventSummary[],
): string =>
  openSection(
    t("admin.dashboard.upcoming_service_events"),
    <ul>{events.map(upcomingServicingRow)}</ul>,
  );
