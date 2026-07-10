/**
 * Admin dashboard page template
 */

import { filter, joinStrings, map, pipe, unique } from "#fp";
import { t } from "#i18n";
import { groupAttendeeRows } from "#shared/attendee-table-rows.ts";
import {
  type ColumnGenerators,
  getHeaderText,
  renderCells,
  resolveColumnLayout,
} from "#shared/column-order.ts";
import {
  EDITOR_LISTING_DEFAULT_ORDER,
  EDITOR_LISTING_TABLE_COLUMNS,
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
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
  Attendee,
  Holiday,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminPage, flashAdminPage } from "#templates/admin/admin-page.tsx";
import { HolidayTable } from "#templates/admin/holidays.tsx";
import {
  attributeFilterHref,
  csvExportHref,
  emptyAttributeFilterView,
  type ListingAttributeFilterView,
  renderAttributeFilterBars,
  typeFilterHref,
} from "#templates/admin/listing-attribute-filters.ts";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import { escapeHtml } from "#templates/layout.tsx";

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

/** The ordered column layout a listings table (or single row) renders from. */
type ListingColumnArgs = {
  columnKeys: string[];
  filters: Map<string, string>;
  columns?: ColumnGenerators<ListingWithCount>;
};

/** Render a single listing table row using ordered column keys. `columns`
 * defaults to the full staff column set; the editor variant passes its
 * money-free, edit-linked set. */
export const ListingRow = ({
  e,
  columnKeys,
  filters,
  columns = LISTING_TABLE_COLUMNS,
}: ListingColumnArgs & { e: ListingWithCount }): string => {
  const isInactive = !e.active;
  const cells = renderCells(
    e,
    columnKeys,
    columns,
    undefined,
    filters,
    escapeHtml,
  );
  return `<tr${isInactive ? ' class="inactive-row"' : ""}>${cells}</tr>`;
};

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
  attendees: Attendee[],
  listings: ListingWithCount[],
): string => {
  const tableRows = groupAttendeeRows(attendees, listings);

  if (tableRows.length === 0) return "";

  const count = tableRows.length;

  return String(
    <details open>
      <summary>{t("admin.dashboard.newest_attendees", { count })}</summary>
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            allowedDomain: getEffectiveDomain(),
            presorted: true,
            rows: tableRows,
            showCheckin: false,
            showDate: false,
            showListing: true,
          })}
        />
      </div>
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

const upcomingServicingRow = (event: ServicingEventSummary) => {
  // One `<li>` per service event (not per booking line), so a multi-listing hold
  // appears once. The compact details carry the listing count rather than every
  // name — the listing names are listed in the `/admin/servicing` table. The
  // date uses the app's deterministic formatter, not the runtime's locale.
  const listingCount = event.bookings.length;
  const details = [
    event.date ? formatDateLabel(event.date) : "",
    `${listingCount} listing${listingCount === 1 ? "" : "s"}`,
    `${event.totalQuantity}`,
  ].filter(Boolean);
  return (
    <li>
      <a href={`/admin/servicing/${event.id}`}>{event.name}</a>{" "}
      <span class="muted">{details.join(" · ")}</span>
    </li>
  );
};

const upcomingServicingSection = (events: ServicingEventSummary[]): string =>
  String(
    <details open>
      <summary>{t("admin.dashboard.upcoming_service_events")}</summary>
      <ul>{events.map(upcomingServicingRow)}</ul>
    </details>,
  );

/** The subset of `columnKeys` that the given column set actually defines. */
export const validListingColumnKeys = (
  columnKeys: string[],
  columns: ColumnGenerators<ListingWithCount>,
): string[] => columnKeys.filter((key) => columns[key]);

/** Render the listing rows (or the single empty-state row) for a listings
 *  table body. Shared by the dashboard listings section and the group detail
 *  page; `emptyText` is the message shown when there are no listings. */
/** The listing collection + column layout every listings table renders from. */
type ListingTableArgs = ListingColumnArgs & {
  listings: ListingWithCount[];
};

export const renderListingRows = ({
  listings,
  columnKeys,
  filters,
  emptyText,
  columns = LISTING_TABLE_COLUMNS,
}: ListingTableArgs & { emptyText: string }): string =>
  listings.length > 0
    ? pipe(
        map((e: ListingWithCount) =>
          ListingRow({ columnKeys, columns, e, filters }),
        ),
        joinStrings,
      )(listings)
    : `<tr><td colspan="${columnKeys.length}">${emptyText}</td></tr>`;

/** Render the listing table with dynamic column keys. `columns` defaults to the
 * staff column set; the editor variant passes its money-free set. */
export const renderListingTable = (
  columnKeys: string[],
  rows: string,
  columns: ColumnGenerators<ListingWithCount> = LISTING_TABLE_COLUMNS,
): string => {
  const headers = pipe(
    map((key: string) => `<th>${getHeaderText(columns[key]!)}</th>`),
    joinStrings,
  )(validListingColumnKeys(columnKeys, columns));
  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
};

export const renderListingsTableSection = (
  listings: ListingWithCount[],
  columnKeys: string[],
  filters: Map<string, string>,
  columns: ColumnGenerators<ListingWithCount> = LISTING_TABLE_COLUMNS,
): string => {
  const listingRows = renderListingRows({
    columnKeys: validListingColumnKeys(columnKeys, columns),
    columns,
    emptyText: t("admin.dashboard.no_listings"),
    filters,
    listings,
  });

  return String(
    <div class="table-scroll">
      <Raw html={renderListingTable(columnKeys, listingRows, columns)} />
    </div>,
  );
};

/** A listings table with an optional filter row above it. When `csvExport` is
 * set, a CSV-export footer is shown below (spaced by the .table-block
 * container). Shared by the dashboard (active-only table, no export) and the
 * listings index (active + deactivated, exports all). */
const ListingsTableBlock = ({
  listings,
  columnKeys,
  filters,
  csvExport = false,
  csvHref = "/admin/listings/csv",
  headerHtml = "",
  columns = LISTING_TABLE_COLUMNS,
}: ListingTableArgs & {
  csvExport?: boolean;
  csvHref?: string;
  headerHtml?: string;
}): JSX.Element => (
  <div class="table-block">
    <Raw html={headerHtml} />
    <Raw
      html={renderListingsTableSection(listings, columnKeys, filters, columns)}
    />
    {csvExport && (
      <div class="table-actions">
        <a href={csvHref}>{t("listings_table.export_csv")}</a>
      </div>
    )}
  </div>
);

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  listings: ListingWithCount[],
  session: AdminSession,
  imageError?: string,
  newestAttendees: Attendee[] = [],
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
