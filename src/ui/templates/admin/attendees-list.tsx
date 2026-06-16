/**
 * Admin attendees browser page — a paginated, filterable table of attendee
 * bookings across every listing. Deliberately minimal: a filter/sort form, the
 * shared attendee table (read-only), and previous/next paging.
 */

import { sort } from "#fp";
import type { AttendeeSort } from "#shared/db/attendees.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  AttendeeTableRow,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";

const NAV_ACTIVE = "/admin/attendees";

export type AttendeesListPageProps = {
  session: AdminSession;
  rows: AttendeeTableRow[];
  listings: ListingWithCount[];
  /** Currently-selected listing filter, or null for "all listings" */
  listingId: number | null;
  sort: AttendeeSort;
  /** Zero-based current page index */
  page: number;
  /** Whether a further page of results exists */
  hasNext: boolean;
  allowedDomain: string;
  phonePrefix: string;
};

/** Build a /admin/attendees URL preserving the filter + sort for a given page */
const pageHref = (
  listingId: number | null,
  sortOrder: AttendeeSort,
  page: number,
): string => {
  const params = new URLSearchParams();
  if (listingId !== null) params.set("listing", String(listingId));
  if (sortOrder === "oldest") params.set("sort", "oldest");
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/attendees?${query}` : "/admin/attendees";
};

/** Listing <option>s sorted by name, deactivated listings flagged inline */
const ListingOptions = ({
  listings,
  selectedId,
}: {
  listings: ListingWithCount[];
  selectedId: number | null;
}): JSX.Element => {
  const sorted = sort((a: ListingWithCount, b: ListingWithCount) =>
    a.name.localeCompare(b.name),
  )(listings);
  return (
    <>
      <option selected={selectedId === null} value="">
        All listings
      </option>
      {sorted.map((e) => (
        <option selected={e.id === selectedId} value={String(e.id)}>
          {e.active ? e.name : `${e.name} (deactivated)`}
        </option>
      ))}
    </>
  );
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
      Listing
      <select name="listing">
        <ListingOptions listings={listings} selectedId={listingId} />
      </select>
    </label>
    <label>
      Sort
      <select name="sort">
        <option selected={sortOrder === "newest"} value="newest">
          Newest first
        </option>
        <option selected={sortOrder === "oldest"} value="oldest">
          Oldest first
        </option>
      </select>
    </label>
    <button type="submit">Apply</button>
  </form>
);

/** Previous/next paging controls (hidden entirely when only one page exists) */
const Pagination = ({
  listingId,
  sortOrder,
  page,
  hasNext,
}: {
  listingId: number | null;
  sortOrder: AttendeeSort;
  page: number;
  hasNext: boolean;
}): JSX.Element | null => {
  if (page === 0 && !hasNext) return null;
  return (
    <nav class="pagination">
      {page > 0 ? (
        <a href={pageHref(listingId, sortOrder, page - 1)} rel="prev">
          ← Previous
        </a>
      ) : (
        <span />
      )}
      <span>Page {page + 1}</span>
      {hasNext ? (
        <a href={pageHref(listingId, sortOrder, page + 1)} rel="next">
          Next →
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
    <Layout title="Attendees">
      <AdminNav active={NAV_ACTIVE} session={props.session} />

      <h1>Attendees</h1>

      <FilterForm
        listingId={props.listingId}
        listings={props.listings}
        sortOrder={props.sort}
      />

      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            allowedDomain: props.allowedDomain,
            emptyMessage: "No attendees yet",
            phonePrefix: props.phonePrefix,
            presorted: true,
            rows: props.rows,
            showActions: false,
            showDate: false,
            showListing: true,
          })}
        />
      </div>

      <Pagination
        hasNext={props.hasNext}
        listingId={props.listingId}
        page={props.page}
        sortOrder={props.sort}
      />
    </Layout>,
  );
