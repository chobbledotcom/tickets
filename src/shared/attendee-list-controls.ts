/**
 * One description of an attendee list's filters and sort. A page says which
 * controls it offers (`AttendeeListSetup`); the visitor's choices are read
 * from the address bar (`readAttendeeListState`) and written back into every
 * link (`attendeeListHref`) by the same table of query parameters, so each
 * list reads its address and builds its links the same way — only the base
 * path differs. This module is pure; the rendering lives in
 * `src/ui/templates/attendee-table/controls.tsx`.
 */

import * as v from "valibot";
import { compact, mapNotNullish, sort } from "#fp";
import { isListingFilter, type ListingFilter } from "#shared/listing-filter.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";

export const AttendeeSortSchema = v.picklist(["newest", "oldest"]);
export type AttendeeSort = v.InferOutput<typeof AttendeeSortSchema>;

/** Type guard: narrows an arbitrary string to an {@link AttendeeSort}. */
export const isAttendeeSort = guardFor(AttendeeSortSchema);

/** The check-in filter: everyone, checked in only, or not checked in only. */
export type AttendeeFilter = "all" | "in" | "out";

/** One day the date dropdown offers. */
export type DateOption = { value: string; label: string };

/**
 * How one attendee list is set up: where it lives and which controls it
 * offers. `Sort` narrows what "no ?sort= in the address" means for this list —
 * an {@link AttendeeSort} for a list whose own order is one of them (the
 * attendees browser starts at newest first), or null for a list whose own
 * order is something else (a listing's roster orders by date and name).
 */
export type AttendeeListSetup<
  Sort extends AttendeeSort | null = AttendeeSort | null,
> = {
  /** The page the filter links land on. */
  basePath: string;
  /** The list's CSV download, or null when it has none. */
  csvPath: string | null;
  /** Listings offered by the listing dropdown; fewer than two hides it. */
  listings: ListingWithCount[];
  /** Whether the list understands the ?type= listing-kind filter. */
  withTypes: boolean;
  /** Whether the list understands the ?date= day filter. */
  withDates: boolean;
  /** Days offered by the date dropdown; empty hides it. */
  dates: DateOption[];
  /** Whether the list offers the checked-in / checked-out filter. */
  withCheckin: boolean;
  /** Whether the list is split into pages (?page=). */
  withPaging: boolean;
  /** The order used when the address names none. */
  defaultSort: Sort;
};

/** The choices a visitor has made on one attendee list, read from the
 *  address bar. `sort` is null when the list's own default order applies. */
export type AttendeeListState<
  Sort extends AttendeeSort | null = AttendeeSort | null,
> = {
  listingId: number | null;
  type: ListingFilter;
  sort: AttendeeSort | Sort;
  checkin: AttendeeFilter;
  date: string | null;
  page: number;
};

/** The chosen listing id, only when it names one of the offered listings —
 *  an unknown or malformed value falls back to "all listings". */
const readChosenListing = (
  listings: ListingWithCount[],
  raw: string | null,
): number | null => {
  const id = raw === null ? null : parsePositiveInt(raw);
  if (id === null) return null;
  return listings.some((listing) => listing.id === id) ? id : null;
};

const readCheckin = (raw: string | null): AttendeeFilter =>
  raw === "in" || raw === "out" ? raw : "all";

/**
 * Read the visitor's choices from a request's query string. Each control is
 * read only when the setup offers it, so a pasted address cannot claim a
 * filter the page has no control for; an unrecognised listing, type, sort, or
 * check-in value falls back to that control's "everything" choice. The day is
 * different: any well-formed day is honoured, even one the dropdown does not
 * offer — an empty list is the honest answer for a day nobody booked, and the
 * CSV export reads days with no dropdown at all. Only a malformed day is
 * ignored.
 */
export const readAttendeeListState = <Sort extends AttendeeSort | null>(
  setup: AttendeeListSetup<Sort>,
  query: URLSearchParams,
): AttendeeListState<Sort> => {
  const rawSort = query.get("sort");
  const rawDate = query.get("date");
  const rawType = query.get("type");
  const rawPage = query.get("page");
  const page = rawPage === null ? null : parsePositiveInt(rawPage);
  return {
    checkin: setup.withCheckin ? readCheckin(query.get("filter")) : "all",
    date:
      setup.withDates && rawDate !== null && isIsoDate(rawDate)
        ? rawDate
        : null,
    listingId: readChosenListing(setup.listings, query.get("listing")),
    page: setup.withPaging && page !== null ? page : 0,
    sort:
      rawSort !== null && isAttendeeSort(rawSort) ? rawSort : setup.defaultSort,
    type: setup.withTypes && isListingFilter(rawType) ? rawType : "all",
  };
};

/** One query parameter: its name, and its value — or null when the state sits
 *  at the parameter's default, which keeps default choices out of addresses. */
type ParamWriter = {
  name: string;
  value: (setup: AttendeeListSetup, state: AttendeeListState) => string | null;
};

const PARAM_WRITERS: ParamWriter[] = [
  {
    name: "listing",
    value: (_setup, state) =>
      state.listingId === null ? null : String(state.listingId),
  },
  {
    name: "type",
    value: (_setup, state) => (state.type === "all" ? null : state.type),
  },
  {
    name: "sort",
    value: (setup, state) =>
      state.sort !== null && state.sort !== setup.defaultSort
        ? state.sort
        : null,
  },
  {
    name: "filter",
    value: (_setup, state) => (state.checkin === "all" ? null : state.checkin),
  },
  { name: "date", value: (_setup, state) => state.date },
  {
    name: "page",
    value: (_setup, state) => (state.page > 0 ? String(state.page) : null),
  },
];

/** The non-default query parameters for a state, in the order links use. */
export const attendeeListParams = (
  setup: AttendeeListSetup,
  state: AttendeeListState,
): [name: string, value: string][] =>
  mapNotNullish((writer: ParamWriter): [string, string] | null => {
    const value = writer.value(setup, state);
    return value === null ? null : [writer.name, value];
  })(PARAM_WRITERS);

/** The address for a state — the setup's base path unless another is given. */
export const attendeeListHref = (
  setup: AttendeeListSetup,
  state: AttendeeListState,
  path: string = setup.basePath,
): string => {
  const query = new URLSearchParams(attendeeListParams(setup, state));
  const qs = query.toString();
  return qs === "" ? path : `${path}?${qs}`;
};

/** A link that changes some of the current choices. Any change starts back at
 *  the first page — only an explicit `page` keeps a page number. */
export const attendeeListLink =
  (setup: AttendeeListSetup, state: AttendeeListState) =>
  (changes: Partial<AttendeeListState>): string =>
    attendeeListHref(setup, { ...state, page: 0, ...changes });

/** The CSV download for the current filters (sort and page do not change what
 *  the export holds), or null when the list has no export. */
export const attendeeListCsvHref = (
  setup: AttendeeListSetup,
  state: AttendeeListState,
): string | null =>
  setup.csvPath === null
    ? null
    : attendeeListHref(
        setup,
        { ...state, page: 0, sort: setup.defaultSort },
        setup.csvPath,
      );

/** One option in a bar of choices: its copy, and the change it makes. */
export type ListChoice = {
  labelKey: string;
  change: Partial<AttendeeListState>;
};

const sortChoice = (
  sort: AttendeeSort | null,
  labelKey: string,
): ListChoice => ({ change: { sort }, labelKey });

/** The sort orders a list offers, its own default first. */
export const attendeeListSortChoices = (
  setup: AttendeeListSetup,
): ListChoice[] =>
  compact([
    setup.defaultSort === null
      ? sortChoice(null, "attendees_list.sort_by_date")
      : null,
    sortChoice("newest", "attendees_list.newest_first"),
    sortChoice("oldest", "attendees_list.oldest_first"),
  ]);

const checkinChoice = (
  checkin: AttendeeFilter,
  labelKey: string,
): ListChoice => ({ change: { checkin }, labelKey });

/** The check-in bar's options: everyone, checked in, not checked in. */
export const ATTENDEE_CHECKIN_CHOICES: ListChoice[] = [
  checkinChoice("all", "listings_table.all"),
  checkinChoice("in", "common.checked_in"),
  checkinChoice("out", "listings_table.checked_out"),
];

const STATE_FIELDS = [
  "listingId",
  "type",
  "sort",
  "checkin",
  "date",
  "page",
] as const;

/** Whether a choice is the one currently in force: every field its change
 *  names already holds that value. */
export const choiceIsActive = (
  state: AttendeeListState,
  change: Partial<AttendeeListState>,
): boolean =>
  STATE_FIELDS.every(
    (field) => !(field in change) || state[field] === change[field],
  );

/** Order rows by when they were registered — their id — newest or oldest
 *  first. This matches what the attendees browser's query means by "newest". */
export const inRegistrationOrder =
  (order: AttendeeSort) =>
  <Row extends { id: number }>(rows: Row[]): Row[] =>
    sort<Row>((first, second) =>
      order === "newest" ? second.id - first.id : first.id - second.id,
    )(rows);
