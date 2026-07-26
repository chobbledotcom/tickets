/**
 * Admin dashboard page template
 */

import { filter, joinStrings, map, pipe, unique } from "#fp";
import { t } from "#i18n";
import { groupAttendeeRows } from "#shared/attendee-table-rows.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ActiveListingStats } from "#shared/db/attendee-types.ts";
import type { ServicingEventSummary } from "#shared/db/attendees/servicing.ts";
import { isReadOnly } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { filterListingsByAttributes } from "#shared/listing-attribute-filter.ts";
import {
  filterListingsByType,
  type ListingFilter,
  listingCategory,
  renderTypeFilter,
} from "#shared/listing-filter.ts";
import type { ListingColumnKey } from "#shared/tables/configurable.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import type {
  AdminSession,
  DisplayAttendee,
  Holiday,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminPage, flashAdminPage } from "#templates/admin/admin-page.tsx";
import { AttendeeTableBlock } from "#templates/admin/attendee-table-block.tsx";
import { HolidayTable } from "#templates/admin/holidays.tsx";
import {
  attributeFilterHref,
  csvExportHref,
  emptyAttributeFilterView,
  type ListingAttributeFilterView,
  renderAttributeFilterBars,
  typeFilterHref,
} from "#templates/admin/listing-attribute-filters.ts";
import {
  editorListingTable,
  ListingsTableBlock,
  listingTable,
  renderListingsTableSection,
} from "#templates/admin/listing-table.tsx";
import { upcomingServicingSection } from "#templates/admin/servicing-events.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";

/** Keeps only the listings that are still active. */
const activeOnly = filter((e: ListingWithCount) => e.active);

/** The dashboard's quick-create actions — shortcuts to add a listing or an
 *  attendee straight from the home page (each section's own sub-nav reaches the
 *  same create flows once you're inside it). */
const DashboardQuickActions = (): JSX.Element => (
  <p class="actions">
    <ActionButton href="/admin/listing/new" icon="plus">
      {t("admin.dashboard.add_listing")}
    </ActionButton>
    <ActionButton href="/admin/attendees/new" icon="user-plus">
      {t("admin.listings.add_attendee")}
    </ActionButton>
  </p>
);

/** Checkbox item for multi-booking link builder */
const MultiBookingCheckbox = ({ e }: { e: ListingWithCount }): string =>
  String(
    <li>
      <label>
        <input
          data-fields={e.fields}
          data-multi-booking-slug={e.slug}
          type="checkbox"
        />
        {` ${e.name}`}
      </label>
    </li>,
  );

/** One read-only, click-to-select field in the multi-booking box: its label,
 * then an input the client script fills in. `marker` is the data attribute the
 * script finds the input by; only the URL field also carries the site domain. */
const MultiBookingField = ({
  id,
  label,
  marker,
  domain,
}: {
  id: string;
  label: string;
  marker: string;
  domain?: string;
}): JSX.Element => (
  <>
    <label for={id}>{label}</label>
    <input
      data-domain={domain}
      {...{ [marker]: true }}
      data-select-on-click
      id={id}
      placeholder={t("admin.dashboard.select_two_or_more")}
      readonly
      type="text"
    />
  </>
);

/** Multi-booking link builder section (only rendered when 2+ selectable
 * listings). The caller has already excluded every listing with no standalone
 * public page — a child and a hidden package's member both 404
 * on their own `/ticket/<slug>` — so an operator can't build a
 * `/ticket/<…+unbookable+…>` URL the server then rejects. */
const multiBookingSection = (
  selectableListings: ListingWithCount[],
): string => {
  const checkboxes = pipe(
    map((e: ListingWithCount) => MultiBookingCheckbox({ e })),
    joinStrings,
  )(selectableListings);

  return String(
    <details>
      <summary>{t("admin.dashboard.multi_booking_link")}</summary>
      <p>{t("admin.dashboard.multi_booking_desc")}</p>
      <ul class="multi-booking-list">
        <Raw html={checkboxes} />
      </ul>
      <MultiBookingField
        domain={getEffectiveDomain()}
        id="multi-booking-url"
        label={t("admin.dashboard.booking_link")}
        marker="data-multi-booking-url"
      />
      <MultiBookingField
        id="multi-booking-embed-script"
        label={t("common.embed_script")}
        marker="data-multi-booking-embed-script"
      />
      <MultiBookingField
        id="multi-booking-embed-iframe"
        label={t("common.embed_iframe")}
        marker="data-multi-booking-embed-iframe"
      />
    </details>,
  );
};

/** Active listing statistics section */
export const activeListingStatsSection = (stats: ActiveListingStats): string =>
  String(
    <details>
      <summary>{t("admin.dashboard.stats_heading")}</summary>
      <ul>
        <li>
          <strong>{t("admin.dashboard.income")}</strong>{" "}
          {formatCurrency(stats.income)}
        </li>
        <li>
          <strong>{t("admin.dashboard.tickets")}</strong> {stats.tickets}
        </li>
        <li>
          <strong>{t("admin.dashboard.attendees")}</strong> {stats.attendees}
        </li>
      </ul>
    </details>,
  );

/** Build the newest attendees section with a details/summary wrapper.
 * One row per attendee: `listings` arrives in display order, so each grouped
 * row's Listings cell follows the listings page ordering. */
const newestAttendeesSection = (
  attendees: DisplayAttendee[],
  listings: ListingWithCount[],
): string => {
  const tableRows = groupAttendeeRows(attendees, listings);

  if (tableRows.length === 0) return "";

  const count = tableRows.length;

  return String(
    <details open>
      <summary>{t("admin.dashboard.newest_attendees", { count })}</summary>
      <AttendeeTableBlock
        options={{
          allowedDomain: getEffectiveDomain(),
          presorted: true,
          rows: tableRows,
          showCheckin: false,
          showDate: false,
          showListing: true,
        }}
      />
    </details>,
  );
};

/** Upcoming holidays section shown on the admin dashboard. */
const upcomingHolidaysSection = (holidays: Holiday[]): string =>
  String(
    <details open>
      <summary>{t("holidays.upcoming_heading")}</summary>
      <Raw
        html={HolidayTable({
          holidays,
          scrollClass: "dashboard-holidays-scroll",
        })}
      />
    </details>,
  );

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  listings: ListingWithCount[],
  session: AdminSession,
  imageError?: string,
  newestAttendees: DisplayAttendee[] = [],
  successMessage?: string,
  stats?: ActiveListingStats | null,
  listingColumnLayout?: TableLayout<ListingColumnKey>,
  activeType: ListingFilter = "all",
  upcomingHolidays: Holiday[] = [],
  unbookableIds: ReadonlySet<number> = new Set(),
  upcomingServicingEvents: ServicingEventSummary[] = [],
  attributeFilterView: ListingAttributeFilterView = emptyAttributeFilterView(),
): string => {
  const { columnKeys, filters } =
    listingColumnLayout ?? listingTable.layout.defaultLayout;

  // Type filter narrows the listing table only; the stats, multi-booking, and
  // newest-attendee sections below stay based on the full set. Offer the bar
  // (same control as the public/attendee filters) only when more than one
  // listing type is present.
  const activeListings = activeOnly(listings);
  // The multi-booking builder offers only standalone-bookable listings; a child
  // is never an entry point (I3) and a hidden package's member 404s on its own
  // page, so both are excluded from the selectable set and the "2+ listings"
  // gate that decides whether to show the builder at all.
  const multiBookingListings = filter(
    (e: ListingWithCount) => !unbookableIds.has(e.id),
  )(activeListings);
  const categories = unique(listings.map(listingCategory));
  const { activeAttributeFilters, attributeFilters, attributesByListing } =
    attributeFilterView;
  const shownListings = filterListingsByAttributes(
    activeAttributeFilters,
    attributesByListing,
  )(filterListingsByType(activeType)(activeListings));
  const typeFilterHtml =
    categories.length > 1
      ? renderTypeFilter(activeType, categories, (f) =>
          typeFilterHref("/admin/", activeAttributeFilters)(f),
        )
      : "";
  const attributeFilterHtml = renderAttributeFilterBars(
    attributeFilters,
    activeAttributeFilters,
    attributeFilterHref("/admin/", activeType, activeAttributeFilters),
  );
  const filterHtml = `${typeFilterHtml}${attributeFilterHtml}`;

  return flashAdminPage(t("terms.listings"), "/admin/")(
    session,
    imageError,
    successMessage,
  )(
    <>
      {!isReadOnly() && <DashboardQuickActions />}

      <ListingsTableBlock
        columnKeys={columnKeys}
        filters={filters}
        headerHtml={filterHtml}
        listings={shownListings}
      />

      {stats && <Raw html={activeListingStatsSection(stats)} />}

      {upcomingHolidays.length > 0 && (
        <Raw html={upcomingHolidaysSection(upcomingHolidays)} />
      )}

      {upcomingServicingEvents.length > 0 && (
        <Raw html={upcomingServicingSection(upcomingServicingEvents)} />
      )}

      {multiBookingListings.length >= 2 && (
        <Raw html={multiBookingSection(multiBookingListings)} />
      )}

      {newestAttendees.length > 0 && (
        <Raw html={newestAttendeesSection(newestAttendees, listings)} />
      )}

      <GuideFooter href="/admin/guide#dashboard">
        {t("admin.dashboard.guide_link")}
      </GuideFooter>
    </>,
  );
};

/** Admin listings index page with active and deactivated listings split. */
export const adminListingsPage = (
  listings: ListingWithCount[],
  session: AdminSession,
  listingColumnLayout?: TableLayout<ListingColumnKey>,
  attributeFilterView: ListingAttributeFilterView = emptyAttributeFilterView(),
): string => {
  // Editors see a money-free, edit-linked table on a fixed order (their saved
  // column template is irrelevant and never references the omitted columns), and
  // no CSV export (that route stays staff-only and exports ledger revenue).
  const isEditor = session.adminLevel === "editor";
  const table = isEditor ? editorListingTable : listingTable;
  const layout = isEditor
    ? undefined
    : (listingColumnLayout ?? listingTable.layout.defaultLayout);
  const activeListings = activeOnly(listings);
  const deactivatedListings = filter((e: ListingWithCount) => !e.active)(
    listings,
  );
  const { activeAttributeFilters, attributeFilters, attributesByListing } =
    attributeFilterView;
  const filterByAttribute = filterListingsByAttributes(
    activeAttributeFilters,
    attributesByListing,
  );
  const attributeFilterHtml = renderAttributeFilterBars(
    attributeFilters,
    activeAttributeFilters,
    attributeFilterHref("/admin/listings", "all", activeAttributeFilters),
  );

  return String(
    <AdminPage
      active="/admin/listings"
      session={session}
      title={t("terms.listings")}
    >
      <ListingsTableBlock
        columnKeys={layout?.columnKeys}
        csvExport={!isEditor}
        csvHref={csvExportHref("all", activeAttributeFilters)}
        filters={layout?.filters}
        headerHtml={attributeFilterHtml}
        listings={filterByAttribute(activeListings)}
        table={table}
      />

      {deactivatedListings.length > 0 && (
        <>
          <h2>{t("admin.dashboard.deactivated")}</h2>
          {renderListingsTableSection({
            columnKeys: layout?.columnKeys,
            emptyText: t("admin.dashboard.no_listings"),
            filters: layout?.filters,
            listings: filterByAttribute(deactivatedListings),
            table,
          })}
        </>
      )}

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#listings">
        {t("admin.listings.guide_link")}
      </GuideFooter>
    </AdminPage>,
  );
};
