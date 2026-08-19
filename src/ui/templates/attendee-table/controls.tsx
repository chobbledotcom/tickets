/**
 * The filter and sort controls every attendee list shares. Each control in
 * {@link CONTROL_ROWS} says when a list offers it, so a page gets exactly the
 * controls its setup supports — the attendees browser gets the type bar and
 * listing dropdown, a listing's roster gets the day dropdown and check-in bar,
 * and both get the sort bar — all linking through the setup's own base path.
 */

import { map, sort, unique } from "#fp";
import { t } from "#i18n";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import {
  ATTENDEE_CHECKIN_CHOICES,
  type AttendeeListSetup,
  type AttendeeListState,
  attendeeListCsvHref,
  attendeeListHref,
  attendeeListLink,
  attendeeListParams,
  attendeeListSortChoices,
  choiceIsActive,
  type ListChoice,
} from "#shared/attendee-list-controls.ts";
import { type FilterBarOption, renderFilterBar } from "#shared/filter-bar.ts";
import { hiddenInputs } from "#shared/forms/hidden-inputs.tsx";
import { renderSelectOptions } from "#shared/forms/rendering.tsx";
import {
  type ListingFilter,
  listingCategory,
  listingFilterLabel,
  renderTypeFilter,
} from "#shared/listing-filter.ts";
import { AttendeeTableBlock } from "#templates/admin/attendee-table-block.tsx";
import type { AttendeeTableOptions } from "#templates/attendee-table/types.ts";
import {
  SelectField,
  type SelectOption,
} from "#templates/components/select-field.tsx";
import type { ListingWithCount } from "#types";

/** One attendee list's controls and choices, handed around as a pair. */
export type AttendeeListView = {
  setup: AttendeeListSetup;
  state: AttendeeListState;
};

/** A link that changes some choices (and starts back at the first page). */
const linkOf = (view: AttendeeListView) =>
  attendeeListLink(view.setup, view.state);

/** A labelled bar of choices, each linking to the change it names and marked
 *  active when its change is already in force. */
const choiceBar = (
  view: AttendeeListView,
  label: string | null,
  choices: ListChoice[],
): string =>
  renderFilterBar(
    label,
    choices.map(
      (choice): FilterBarOption => ({
        active: choiceIsActive(view.state, choice.change),
        href: linkOf(view)(choice.change),
        label: t(choice.labelKey),
      }),
    ),
  );

/** The listing kinds present, for the type bar (hidden below two kinds). */
const categoriesOf = (view: AttendeeListView): ListingFilter[] =>
  unique(map(listingCategory)(view.setup.listings));

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

/** The day dropdown: each option's value is the address it navigates to. */
const dateSelect = (view: AttendeeListView): string => {
  const link = linkOf(view);
  const options = renderSelectOptions([
    {
      label: t("listings_table.all_dates"),
      selected: view.state.date === null,
      value: link({ date: null }),
    },
    ...view.setup.dates.map((d) => ({
      label: d.label,
      selected: view.state.date === d.value,
      value: link({ date: d.value }),
    })),
  ]);
  return `<select data-nav-select aria-label="${t(
    "listings_table.filter_by_date",
  )}">${options}</select>`;
};

/** The listing dropdown as a GET form, so results stay bookmarkable. Hidden
 * inputs carry the other active choices, so applying it keeps them. */
const ListingForm = (view: AttendeeListView): JSX.Element => {
  const hidden = attendeeListParams(view.setup, {
    ...view.state,
    listingId: null,
    page: 0,
  });
  return (
    <form action={view.setup.basePath} class="filter-row" method="get">
      {hiddenInputs(hidden)}
      <label>
        {t("terms.listing")}
        <SelectField
          name="listing"
          options={listingOptions(view.setup.listings)}
          value={
            view.state.listingId === null ? "" : String(view.state.listingId)
          }
        />
      </label>
      <button type="submit">{t("attendees_list.apply")}</button>
    </form>
  );
};

/** The controls, in display order: each says when a list offers it. */
const CONTROL_ROWS: {
  offered: (view: AttendeeListView) => boolean;
  render: (view: AttendeeListView) => string;
}[] = [
  {
    offered: (view) => categoriesOf(view).length > 1,
    render: (view) =>
      renderTypeFilter(view.state.type, categoriesOf(view), (f) =>
        linkOf(view)({ listingId: null, type: f }),
      ),
  },
  {
    offered: (view) => view.setup.dates.length > 0,
    render: dateSelect,
  },
  {
    offered: (view) => view.setup.withCheckin,
    render: (view) => choiceBar(view, null, ATTENDEE_CHECKIN_CHOICES),
  },
  {
    offered: () => true,
    render: (view) =>
      choiceBar(
        view,
        t("attendees_list.sort"),
        attendeeListSortChoices(view.setup),
      ),
  },
  {
    offered: (view) => view.setup.listings.length > 1,
    render: (view) => String(ListingForm(view)),
  },
];

/** The filter/sort controls this list offers, in display order. */
export const AttendeeListControls = (view: AttendeeListView): JSX.Element => (
  <>
    {CONTROL_ROWS.filter((row) => row.offered(view)).map((row) => (
      <Raw html={row.render(view)} />
    ))}
  </>
);

/** The "Showing N attendees for <Type>" line under the type bar. */
const ResultCount = ({
  view,
  count,
}: {
  view: AttendeeListView;
  count: number;
}): JSX.Element | null =>
  view.state.type === "all" ? null : (
    <p>
      {t("attendees_list.showing_count", { count })}{" "}
      <strong>{listingFilterLabel(view.state.type)}</strong>
    </p>
  );

/** Previous/next paging controls (hidden entirely when only one page exists) */
export const AttendeeListPagination = ({
  view,
  hasNext,
}: {
  view: AttendeeListView;
  hasNext: boolean;
}): JSX.Element | null => {
  const { page } = view.state;
  if (page === 0 && !hasNext) return null;
  const pageHref = (target: number): string =>
    attendeeListHref(view.setup, { ...view.state, page: target });
  return (
    <nav class="pagination">
      {page > 0 ? (
        <a href={pageHref(page - 1)} rel="prev">
          {t("attendees_list.previous")}
        </a>
      ) : (
        <span />
      )}
      <span>{t("attendees_list.page_number", { number: page + 1 })}</span>
      {hasNext ? (
        <a href={pageHref(page + 1)} rel="next">
          {t("attendees_list.next")}
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
};

/**
 * An attendee table with its list's controls figured out for it: the offered
 * filter/sort bars above, the CSV download (when the list has one) and any
 * extra actions below, then paging. Reuse this wherever a filterable list of
 * attendees renders.
 */
export const FilteredAttendeeTable = ({
  view,
  options,
  hasNext = false,
  actions,
}: {
  view: AttendeeListView;
  options: AttendeeTableOptions;
  hasNext?: boolean;
  actions?: Child;
}): JSX.Element => {
  const csvHref = attendeeListCsvHref(view.setup, view.state);
  return (
    <>
      <AttendeeListControls {...view} />
      <ResultCount count={options.rows.length} view={view} />
      <AttendeeTableBlock
        actions={
          <>
            {csvHref !== null && (
              <a href={csvHref}>{t("listings_table.export_csv")}</a>
            )}
            {actions}
          </>
        }
        options={options}
      />
      <AttendeeListPagination hasNext={hasNext} view={view} />
    </>
  );
};
