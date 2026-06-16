/**
 * Admin dashboard page template
 */

import { filter, joinStrings, map, pipe, reduce, unique } from "#fp";
import { t } from "#i18n";
import {
  getHeaderText,
  renderCells,
  resolveColumnLayout,
} from "#shared/column-order.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ActiveListingStats } from "#shared/db/attendees.ts";
import { isReadOnly } from "#shared/env.ts";
import { Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type ListingFilter,
  listingCategory,
  renderTypeFilter,
} from "#shared/listing-filter.ts";
import type {
  AdminSession,
  Attendee,
  AttendeeTableRow,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Render a single listing table row using ordered column keys */
export const ListingRow = ({
  e,
  columnKeys,
  filters,
}: {
  e: ListingWithCount;
  columnKeys: string[];
  filters: Map<string, string>;
}): string => {
  const isInactive = !e.active;
  const cells = renderCells(
    e,
    columnKeys,
    LISTING_TABLE_COLUMNS,
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

/** Multi-booking link builder section (only rendered when 2+ active listings) */
const multiBookingSection = (activeListings: ListingWithCount[]): string => {
  const checkboxes = pipe(
    map((e: ListingWithCount) => MultiBookingCheckbox({ e })),
    joinStrings,
  )(activeListings);

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

/** Build the newest attendees section with a details/summary wrapper */
const newestAttendeesSection = (
  attendees: Attendee[],
  listings: ListingWithCount[],
): string => {
  const listingMap = new Map(listings.map((e) => [e.id, e]));
  const tableRows = reduce((acc: AttendeeTableRow[], a: Attendee) => {
    const listing = listingMap.get(a.listing_id);
    if (listing) {
      acc.push({
        attendee: a,
        listingId: listing.id,
        listingName: listing.name,
      });
    }
    return acc;
  }, [] as AttendeeTableRow[])(attendees);

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

/** Render the listing table with dynamic column keys */
export const renderListingTable = (
  columnKeys: string[],
  rows: string,
): string => {
  const headers = pipe(
    map(
      (key: string) => `<th>${getHeaderText(LISTING_TABLE_COLUMNS[key]!)}</th>`,
    ),
    joinStrings,
  )(columnKeys);
  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
};

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
  const categories = unique(listings.map(listingCategory));
  const shownListings =
    activeType === "all"
      ? listings
      : filter((e: ListingWithCount) => listingCategory(e) === activeType)(
          listings,
        );
  const typeFilterHtml =
    categories.length > 1
      ? renderTypeFilter(activeType, categories, (f) =>
          f === "all" ? "/admin/" : `/admin/?type=${f}`,
        )
      : "";

  const listingRows =
    shownListings.length > 0
      ? pipe(
          map((e: ListingWithCount) => ListingRow({ columnKeys, e, filters })),
          joinStrings,
        )(shownListings)
      : `<tr><td colspan="${columnKeys.length}">${t("admin.dashboard.no_listings")}</td></tr>`;

  const activeListings = filter((e: ListingWithCount) => e.active)(listings);

  return String(
    <Layout title={t("terms.listings")}>
      <AdminNav active="/admin/" session={session} />

      <Flash error={imageError} success={successMessage} />

      {!isReadOnly() && (
        <p class="actions">
          <ActionButton href="/admin/listing/new" icon="plus">
            {t("admin.dashboard.add_listing")}
          </ActionButton>
          <ActionButton href="/admin/attendees/new" icon="plus">
            Add Attendee
          </ActionButton>
        </p>
      )}

      <Raw html={typeFilterHtml} />

      <div class="table-scroll">
        <Raw html={renderListingTable(columnKeys, listingRows)} />
      </div>

      {stats && <Raw html={activeListingStatsSection(stats)} />}

      {activeListings.length >= 2 && (
        <Raw html={multiBookingSection(activeListings)} />
      )}

      {newestAttendees.length > 0 && (
        <Raw html={newestAttendeesSection(newestAttendees, listings)} />
      )}
    </Layout>,
  );
};
