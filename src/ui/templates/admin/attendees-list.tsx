/**
 * Admin attendees browser page — a paginated, filterable table of attendee
 * bookings across every listing. Deliberately minimal: a filter/sort form, the
 * shared attendee table (read-only), and previous/next paging.
 */

/* jscpd:ignore-start */
import { sort } from "#fp";
import { t } from "#i18n";
import type { AttendeeSort } from "#shared/db/attendees.ts";
import type { SystemNote } from "#shared/db/system-notes.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type ListingFilter,
  listingFilterLabel,
  renderTypeFilter,
} from "#shared/listing-filter.ts";
import type {
  AdminSession,
  AttendeeTableRow,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { AttendeeNotesSummary } from "#templates/admin/attendee-notes.tsx";
import { AttendeeTableBlock } from "#templates/admin/attendee-table-block.tsx";
import {
  SelectField,
  type SelectOption,
} from "#templates/components/select-field.tsx";

/* jscpd:ignore-end */

const NAV_ACTIVE = "/admin/attendees";

export type AttendeesListPageProps = {
  session: AdminSession;
  rows: AttendeeTableRow[];
  listings: ListingWithCount[];
  /** Currently-selected listing filter, or null for "all listings" */
  listingId: number | null;
  /** Active listing-type filter ("all" when not type-filtering) */
  type: ListingFilter;
  /** Distinct listing categories present, for the type filter bar */
  categories: readonly ListingFilter[];
  /** Number of attendee rows shown on this page */
  count: number;
  sort: AttendeeSort;
  /** Zero-based current page index */
  page: number;
  /** Whether a further page of results exists */
  hasNext: boolean;
  allowedDomain: string;
  phonePrefix: string;
  /** Decrypted notes for the listed attendees (empty when none). */
  systemNotes?: SystemNote[];
  /** Attendee id → display name, for labelling notes in the summary. */
  names?: Map<number, string>;
};

/** The listing + type filter query params shared by the page and CSV links. */
const filterParams = (
  listingId: number | null,
  type: ListingFilter,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (listingId !== null) params.set("listing", String(listingId));
  if (type !== "all") params.set("type", type);
  return params;
};

/** Append a query string to an /admin/attendees path, omitting "?" when empty. */
const attendeesUrl = (path: string, params: URLSearchParams): string => {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};

/** Build a /admin/attendees URL preserving the filters + sort for a given page */
const pageHref = (
  listingId: number | null,
  type: ListingFilter,
  sortOrder: AttendeeSort,
  page: number,
): string => {
  const params = filterParams(listingId, type);
  if (sortOrder === "oldest") params.set("sort", "oldest");
  if (page > 0) params.set("page", String(page));
  return attendeesUrl("/admin/attendees", params);
};

/** Build the /admin/attendees/csv export URL, carrying the active filters. */
const csvHref = (listingId: number | null, type: ListingFilter): string =>
  attendeesUrl("/admin/attendees/csv", filterParams(listingId, type));

/** A type-filter bar link: select a type (or "all"), keep the sort, reset the
 * specific-listing filter and the page. */
const typeFilterHref = (type: ListingFilter, sortOrder: AttendeeSort): string =>
  pageHref(null, type, sortOrder, 0);

/** Listing options sorted by name, deactivated listings flagged inline, with a
 * leading "all listings" entry. */
const listingOptions = (listings: ListingWithCount[]): SelectOption[] => {
  const sorted = sort((a: ListingWithCount, b: ListingWithCount) =>
    a.name.localeCompare(b.name),
  )(listings);
  return [
    { label: t("attendees_list.all_listings"), value: "" },
    ...sorted.map((e) => ({
      label: e.active ? e.name : `${e.name} ${t("attendees_list.deactivated")}`,
      value: String(e.id),
    })),
  ];
};

/** Filter + sort form — a plain GET form so results stay bookmarkable */
const FilterForm = ({
  listings,
  listingId,
  sortOrder,
}: {
  listings: ListingWithCount[];
  listingId: number | null;
  sortOrder: AttendeeSort;
}): JSX.Element => (
  <form action="/admin/attendees" class="filter-row" method="get">
    <label>
      {t("terms.listing")}
      <SelectField
        name="listing"
        options={listingOptions(listings)}
        value={listingId === null ? "" : String(listingId)}
      />
    </label>
    <label>
      {t("attendees_list.sort")}
      <SelectField
        name="sort"
        options={[
          { label: t("attendees_list.newest_first"), value: "newest" },
          { label: t("attendees_list.oldest_first"), value: "oldest" },
        ]}
        value={sortOrder}
      />
    </label>
    <button type="submit">{t("attendees_list.apply")}</button>
  </form>
);

/** Previous/next paging controls (hidden entirely when only one page exists) */
const Pagination = ({
  listingId,
  type,
  sortOrder,
  page,
  hasNext,
}: {
  listingId: number | null;
  type: ListingFilter;
  sortOrder: AttendeeSort;
  page: number;
  hasNext: boolean;
}): JSX.Element | null => {
  if (page === 0 && !hasNext) return null;
  return (
    <nav class="pagination">
      {page > 0 ? (
        <a href={pageHref(listingId, type, sortOrder, page - 1)} rel="prev">
          {t("attendees_list.previous")}
        </a>
      ) : (
        <span />
      )}
      <span>{t("attendees_list.page_number", { number: page + 1 })}</span>
      {hasNext ? (
        <a href={pageHref(listingId, type, sortOrder, page + 1)} rel="next">
          {t("attendees_list.next")}
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
};

/** Admin attendees browser page */
export const adminAttendeesListPage = (props: AttendeesListPageProps): string =>
  String(
    <AdminPage
      active={NAV_ACTIVE}
      session={props.session}
      title={t("terms.attendees")}
    >
      <div class="table-controls">
        {props.categories.length > 1 && (
          <Raw
            html={renderTypeFilter(props.type, props.categories, (f) =>
              typeFilterHref(f, props.sort),
            )}
          />
        )}

        {props.type !== "all" && (
          <p>
            {t("attendees_list.showing_count", { count: props.count })}{" "}
            <strong>{listingFilterLabel(props.type)}</strong>
          </p>
        )}

        <FilterForm
          listingId={props.listingId}
          listings={props.listings}
          sortOrder={props.sort}
        />

        <AttendeeNotesSummary
          names={props.names ?? new Map()}
          notes={props.systemNotes ?? []}
        />

        <AttendeeTableBlock
          actions={
            <a href={csvHref(props.listingId, props.type)}>
              {t("listings_table.export_csv")}
            </a>
          }
          options={{
            allowedDomain: props.allowedDomain,
            emptyMessage: t("attendees_list.no_attendees_yet"),
            phonePrefix: props.phonePrefix,
            presorted: true,
            rows: props.rows,
            showCheckin: false,
            showDate: false,
            showListing: true,
          }}
        />
      </div>

      <Pagination
        hasNext={props.hasNext}
        listingId={props.listingId}
        page={props.page}
        sortOrder={props.sort}
        type={props.type}
      />
    </AdminPage>,
  );
