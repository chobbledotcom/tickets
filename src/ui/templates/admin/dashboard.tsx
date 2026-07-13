/**
 * Admin dashboard page template
 */

import { filter, joinStrings, map, pipe, unique } from "#fp";
import { t } from "#i18n";
import { groupAttendeeRows } from "#shared/attendee-table-rows.ts";
import { resolveColumnLayout } from "#shared/column-order.ts";
import {
  EDITOR_LISTING_DEFAULT_ORDER,
  EDITOR_LISTING_TABLE_COLUMNS,
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
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
  ListingsTableBlock,
  renderListingsTableSection,
} from "#templates/admin/listing-table.tsx";
import { upcomingServicingSection } from "#templates/admin/servicing-events.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";

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
      <label for="multi-booking-url">{t("admin.dashboard.booking_link")}</label>
      <input
        data-domain={getEffectiveDomain()}
        data-multi-booking-url
        data-select-on-click
        id="multi-booking-url"
        placeholder={t("admin.dashboard.select_two_or_more")}
        readonly
        type="text"
      />
      <label for="multi-booking-embed-script">{t("common.embed_script")}</label>
      <input
        data-multi-booking-embed-script
        data-select-on-click
        id="multi-booking-embed-script"
        placeholder={t("admin.dashboard.select_two_or_more")}
        readonly
        type="text"
      />
      <label for="multi-booking-embed-iframe">{t("common.embed_iframe")}</label>
      <input
        data-multi-booking-embed-iframe
        data-select-on-click
        id="multi-booking-embed-iframe"
        placeholder={t("admin.dashboard.select_two_or_more")}
        readonly
        type="text"
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
  listingColumnTemplate?: string,
  activeType: ListingFilter = "all",
  upcomingHolidays: Holiday[] = [],
  unbookableIds: ReadonlySet<number> = new Set(),
  upcomingServicingEvents: ServicingEventSummary[] = [],
  attributeFilterView: ListingAttributeFilterView = emptyAttributeFilterView(),
): string => {
  const { columnKeys, filters } = resolveColumnLayout(
    listingColumnTemplate ?? "",
    Object.keys(LISTING_TABLE_COLUMNS),
    LISTING_DEFAULT_ORDER,
  );

  // Type filter narrows the listing table only; the stats, multi-booking, and
  // newest-attendee sections below stay based on the full set. Offer the bar
  // (same control as the public/attendee filters) only when more than one
  // listing type is present.
  const activeListings = filter((e: ListingWithCount) => e.active)(listings);
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
  listingColumnTemplate?: string,
  attributeFilterView: ListingAttributeFilterView = emptyAttributeFilterView(),
): string => {
  // Editors see a money-free, edit-linked table on a fixed order (their saved
  // column template is irrelevant and never references the omitted columns), and
  // no CSV export (that route stays staff-only and exports ledger revenue).
  const isEditor = session.adminLevel === "editor";
  const columns = isEditor
    ? EDITOR_LISTING_TABLE_COLUMNS
    : LISTING_TABLE_COLUMNS;
  const { columnKeys, filters } = resolveColumnLayout(
    isEditor ? "" : (listingColumnTemplate ?? ""),
    Object.keys(columns),
    isEditor ? EDITOR_LISTING_DEFAULT_ORDER : LISTING_DEFAULT_ORDER,
  );
  const activeListings = filter((e: ListingWithCount) => e.active)(listings);
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
        columnKeys={columnKeys}
        columns={columns}
        csvExport={!isEditor}
        csvHref={csvExportHref("all", activeAttributeFilters)}
        filters={filters}
        headerHtml={attributeFilterHtml}
        listings={filterByAttribute(activeListings)}
      />

      {deactivatedListings.length > 0 && (
        <>
          <h2>{t("admin.dashboard.deactivated")}</h2>
          <Raw
            html={renderListingsTableSection(
              filterByAttribute(deactivatedListings),
              columnKeys,
              filters,
              columns,
            )}
          />
        </>
      )}

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#listings">
        {t("admin.listings.guide_link")}
      </GuideFooter>
    </AdminPage>,
  );
};
