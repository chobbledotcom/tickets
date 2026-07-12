import * as v from "valibot";
import { map } from "#fp";
import { t } from "#i18n";
import type { SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";

/** The whole filter state the ledger page round-trips through the query string. */
export type LedgerFilterState = {
  from: string | null;
  groupId: number | null;
  to: string | null;
  listingId: number | null;
  fromMonth: string | null;
  toMonth: string | null;
  view: LedgerViewMode;
};

/** The two renderings of the transfer list, derived from one declaration. */
export const LedgerViewModeSchema = v.picklist(["human", "dual"]);
export type LedgerViewMode = v.InferOutput<typeof LedgerViewModeSchema>;

export type LedgerListingOption = { id: number; name: string };
export type LedgerGroupOption = { id: number; name: string };

export type LedgerFilterData = {
  dates: DatePickerDate[];
  filters: LedgerFilterState;
  groups: LedgerGroupOption[];
  listings: LedgerListingOption[];
  today: string;
};

/** Build a ledger URL from the current filters plus an override. */
const ledgerHref = (
  filters: LedgerFilterState,
  overrides: Partial<LedgerFilterState>,
  fragment = "",
): string => {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.from) params.set("from", merged.from);
  if (merged.to) params.set("to", merged.to);
  if (merged.listingId !== null) {
    params.set("listing", String(merged.listingId));
  } else if (merged.groupId !== null) {
    params.set("group", String(merged.groupId));
  }
  if (merged.view === "dual") params.set("view", "dual");
  if (merged.fromMonth) params.set("fromCal", merged.fromMonth);
  if (merged.toMonth) params.set("toCal", merged.toMonth);
  const query = params.toString();
  return `/admin/ledger${query ? `?${query}` : ""}${fragment}`;
};

type RangeSide = {
  anchorId: string;
  labelKey: string;
  pick: (filters: LedgerFilterState) => {
    date: string | null;
    month: string | null;
  };
  setDate: (value: string | null) => Partial<LedgerFilterState>;
  setMonth: (month: string) => Partial<LedgerFilterState>;
};

const RANGE_SIDES: RangeSide[] = [
  {
    anchorId: "ledger-from",
    labelKey: "admin.ledger.filter.from",
    pick: (filters) => ({
      date: filters.from,
      month: filters.fromMonth,
    }),
    setDate: (value) => ({ from: value }),
    setMonth: (month) => ({ fromMonth: month }),
  },
  {
    anchorId: "ledger-to",
    labelKey: "admin.ledger.filter.to",
    pick: (filters) => ({ date: filters.to, month: filters.toMonth }),
    setDate: (value) => ({ to: value }),
    setMonth: (month) => ({ toMonth: month }),
  },
];

const RangeField = ({
  data,
  side,
}: {
  data: LedgerFilterData;
  side: RangeSide;
}): SafeHtml => {
  const current = side.pick(data.filters);
  const fragment = `#${side.anchorId}`;
  return (
    <div class="ledger-date-field">
      <strong>{t(side.labelKey)}</strong>
      {DatePicker({
        anchorId: side.anchorId,
        ariaLabel: t(side.labelKey),
        clearHref: ledgerHref(data.filters, side.setDate(null), fragment),
        dates: data.dates,
        dayHref: (value) =>
          ledgerHref(data.filters, side.setDate(value), fragment),
        monthHref: (month) =>
          ledgerHref(data.filters, side.setMonth(month), fragment),
        selected: current.date,
        today: data.today,
        viewMonth: current.month,
      })}
    </div>
  );
};

export const LedgerDateRange = ({
  data,
}: {
  data: LedgerFilterData;
}): SafeHtml => (
  <div class="ledger-date-range">
    {map((side: RangeSide): SafeHtml => <RangeField data={data} side={side} />)(
      RANGE_SIDES,
    )}
  </div>
);

/** The scope filter: everything, one listing, or one group's current listings. */
export const ScopeFilter = ({ data }: { data: LedgerFilterData }): SafeHtml => (
  <p class="table-action-btns">
    {t("admin.ledger.filter.scope")}:
    <select aria-label={t("admin.ledger.filter.scope")} data-nav-select>
      <option
        selected={
          data.filters.listingId === null && data.filters.groupId === null
        }
        value={ledgerHref(data.filters, { groupId: null, listingId: null })}
      >
        {t("admin.ledger.filter.all")}
      </option>
      <optgroup label={t("admin.ledger.filter.listings")}>
        {map(
          (listing: LedgerListingOption): SafeHtml => (
            <option
              selected={data.filters.listingId === listing.id}
              value={ledgerHref(data.filters, {
                groupId: null,
                listingId: listing.id,
              })}
            >
              {listing.name}
            </option>
          ),
        )(data.listings)}
      </optgroup>
      <optgroup label={t("admin.ledger.filter.groups")}>
        {map(
          (group: LedgerGroupOption): SafeHtml => (
            <option
              selected={data.filters.groupId === group.id}
              value={ledgerHref(data.filters, {
                groupId: group.id,
                listingId: null,
              })}
            >
              {group.name}
            </option>
          ),
        )(data.groups)}
      </optgroup>
    </select>
  </p>
);

/** Render the active view as text and the other view as a link. */
export const LedgerViewToggle = ({
  data,
}: {
  data: LedgerFilterData;
}): SafeHtml => (
  <p class="table-action-btns">
    {map((mode: LedgerViewMode): SafeHtml => {
      const label = t(`admin.ledger.view.${mode}`);
      return data.filters.view === mode ? (
        <strong>{label}</strong>
      ) : (
        <a href={ledgerHref(data.filters, { view: mode })}>{label}</a>
      );
    })(LedgerViewModeSchema.options)}
  </p>
);
