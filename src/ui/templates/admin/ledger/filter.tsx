import * as v from "valibot";
import { map } from "#fp";
import { t } from "#i18n";
import type { SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import {
  ALL_LEDGER_SCOPE,
  type LedgerScope,
  type LedgerScopeOption,
  ledgerScopeSelected,
  setLedgerScopeParam,
} from "#shared/ledger-scope.ts";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";

/** The whole filter state the ledger page round-trips through the query string. */
export type LedgerFilterState = {
  from: string | null;
  to: string | null;
  fromMonth: string | null;
  scope: LedgerScope;
  toMonth: string | null;
  view: LedgerViewMode;
};

/** The two renderings of the transfer list, derived from one declaration. */
export const LedgerViewModeSchema = v.picklist(["human", "dual"]);
export type LedgerViewMode = v.InferOutput<typeof LedgerViewModeSchema>;

export type LedgerFilterData = {
  dates: DatePickerDate[];
  filters: LedgerFilterState;
  groups: LedgerScopeOption[];
  listings: LedgerScopeOption[];
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
  setLedgerScopeParam(params, merged.scope);
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

type NamedLedgerScopeKind = Exclude<LedgerScope["kind"], "all">;

const NAMED_SCOPE_FACTORIES: Record<
  NamedLedgerScopeKind,
  (option: LedgerScopeOption) => LedgerScope
> = {
  group: (option) => ({ ...option, kind: "group" }),
  listing: (option) => ({ ...option, kind: "listing" }),
};

const scopeOptions = (
  kind: NamedLedgerScopeKind,
  options: LedgerScopeOption[],
  filters: LedgerFilterState,
): SafeHtml[] =>
  map((option: LedgerScopeOption): SafeHtml => {
    const scope = NAMED_SCOPE_FACTORIES[kind](option);
    return (
      <option
        selected={ledgerScopeSelected(filters.scope, scope)}
        value={ledgerHref(filters, { scope })}
      >
        {option.name}
      </option>
    );
  })(options);

/** The scope filter: everything, one listing, or one group's current listings. */
export const ScopeFilter = ({ data }: { data: LedgerFilterData }): SafeHtml => (
  <p class="table-action-btns">
    {t("admin.ledger.filter.scope")}{" "}
    <select aria-label={t("admin.ledger.filter.scope")} data-nav-select>
      <option
        selected={ledgerScopeSelected(data.filters.scope, ALL_LEDGER_SCOPE)}
        value={ledgerHref(data.filters, { scope: ALL_LEDGER_SCOPE })}
      >
        {t("admin.ledger.filter.all")}
      </option>
      <optgroup label={t("admin.ledger.filter.listings")}>
        {scopeOptions("listing", data.listings, data.filters)}
      </optgroup>
      <optgroup label={t("admin.ledger.filter.groups")}>
        {scopeOptions("group", data.groups, data.filters)}
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
