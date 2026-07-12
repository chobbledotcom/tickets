import * as v from "valibot";
import { sort } from "#fp";
import { t } from "#i18n";
import { loadLedgerNames } from "#routes/admin/ledger/names.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  type ListingMoneyTotals,
  listingMoneyTotals,
} from "#shared/accounting/listing-money-totals.ts";
import {
  ledgerTotals,
  transferActivityBounds,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import type { LedgerRange } from "#shared/accounting/range.ts";
import { formatSignedCurrency } from "#shared/currency.ts";
import { addDays, dateRange, formatDateLabel } from "#shared/dates.ts";
import { getAllGroupNames, getGroupListingIds } from "#shared/db/groups.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type LedgerScope,
  type LedgerScopeOption,
  listingIdsForLedgerScope,
  resolveLedgerScope,
} from "#shared/ledger-scope.ts";
import {
  dayStartEpochMs,
  epochMsToTzDate,
  todayInTz,
} from "#shared/timezone.ts";
import { isIsoDate, isIsoMonth } from "#shared/validation/date.ts";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  type LedgerFilterState,
  type LedgerViewMode,
  LedgerViewModeSchema,
} from "#templates/admin/ledger/filter.tsx";
import { adminLedgerPage } from "#templates/admin/ledger.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";

const LEDGER_DISPLAY_LIMIT = 500;

const validatedParam =
  (valid: (value: string) => boolean) =>
  (params: URLSearchParams, key: string): string | null => {
    const value = params.get(key);
    return value && valid(value) ? value : null;
  };

const dateParam = validatedParam(isIsoDate);
const monthParam = validatedParam(isIsoMonth);

const viewParam = (params: URLSearchParams): LedgerViewMode => {
  const parsed = v.safeParse(LedgerViewModeSchema, params.get("view"));
  return parsed.success ? parsed.output : "human";
};

const filterRange = (
  from: string | null,
  to: string | null,
  tz: string,
): LedgerRange => ({
  endMs: to ? dayStartEpochMs(addDays(to, 1), tz) : null,
  startMs: from ? dayStartEpochMs(from, tz) : null,
});

export const pickerDatesFromBounds = (
  bounds: { minMs: number; maxMs: number } | null,
  today: string,
  tz: string,
): DatePickerDate[] => {
  if (!bounds) return [];
  const startDay = epochMsToTzDate(bounds.minMs, tz);
  const latest = epochMsToTzDate(bounds.maxMs, tz);
  const endDay = latest > today ? latest : today;
  return dateRange(startDay, endDay).map((value) => ({
    label: formatDateLabel(value),
    selectable: true,
    value,
  }));
};

const buildPickerDates = async (
  tz: string,
  today: string,
): Promise<DatePickerDate[]> =>
  pickerDatesFromBounds(await transferActivityBounds(), today, tz);

const sortScopeOptions = (options: LedgerScopeOption[]): LedgerScopeOption[] =>
  sort((a: LedgerScopeOption, b: LedgerScopeOption) =>
    a.name.localeCompare(b.name),
  )(options);

const moneyRow = (key: string, amount: number, signed = false): DetailRow => ({
  key: t(key),
  value: formatSignedCurrency(amount, signed),
});

const listingMoneyRows = (money: ListingMoneyTotals): DetailRow[] => [
  moneyRow("admin.ledger.stats.gross_sales", money.grossSales, true),
  moneyRow(
    "admin.ledger.stats.recognised_income",
    money.recognisedIncome,
    true,
  ),
  moneyRow("admin.ledger.stats.servicing_costs", -money.servicingCosts, true),
  moneyRow("admin.ledger.stats.refunded", -money.refunds, true),
  moneyRow("admin.ledger.stats.external_costs", -money.externalCosts, true),
  moneyRow(
    "admin.ledger.stats.net_after_costs",
    money.netBalance - money.servicingCosts,
  ),
];

const buildStats = async (
  range: LedgerRange,
  scope: LedgerScope,
  groupListingIds: number[],
): Promise<{ rows: DetailRow[]; heading: string | null }> => {
  switch (scope.kind) {
    case "all": {
      const totals = await ledgerTotals(range);
      return {
        heading: null,
        rows: [
          moneyRow("admin.ledger.stats.income", totals.income, true),
          moneyRow("admin.ledger.stats.due", totals.due),
          moneyRow("admin.ledger.stats.refunded", -totals.refunded, true),
          moneyRow("admin.ledger.stats.fees", totals.fees, true),
        ],
      };
    }
    case "listing":
      return {
        heading: scope.name,
        rows: listingMoneyRows(await listingMoneyTotals(range, [scope.id])),
      };
    case "group":
      return {
        heading: scope.name,
        rows: listingMoneyRows(
          await listingMoneyTotals(range, groupListingIds),
        ),
      };
  }
};

export const handleLedgerGet: TypedRouteHandler<"GET /admin/ledger"> = (
  request,
) =>
  requireOwnerOr(request, async (session) => {
    const url = new URL(request.url);
    const params = url.searchParams;
    const from = dateParam(params, "from");
    const to = dateParam(params, "to");
    const tz = settings.timezone;
    const today = todayInTz(tz);
    const range = filterRange(from, to, tz);

    const [listings, groupNames] = await Promise.all([
      getAllListings(),
      getAllGroupNames(),
    ]);
    const listingOptions = sortScopeOptions(
      listings.map((listing) => ({ id: listing.id, name: listing.name })),
    );
    const groupOptions = sortScopeOptions(
      [...groupNames].map(([id, name]) => ({ id, name })),
    );
    const scope = resolveLedgerScope(params, listingOptions, groupOptions);
    const groupListingIds =
      scope.kind === "group" ? await getGroupListingIds(scope.id) : [];
    const fetched = await visibleTransfers(
      range,
      listingIdsForLedgerScope(scope, groupListingIds),
      LEDGER_DISPLAY_LIMIT + 1,
    );
    const truncated = fetched.length > LEDGER_DISPLAY_LIMIT;
    const transfers = truncated
      ? fetched.slice(0, LEDGER_DISPLAY_LIMIT)
      : fetched;
    const [names, stats, dates] = await Promise.all([
      loadLedgerNames(transfers),
      buildStats(range, scope, groupListingIds),
      buildPickerDates(tz, today),
    ]);
    const filters: LedgerFilterState = {
      from,
      fromMonth: monthParam(params, "fromCal"),
      scope,
      to,
      toMonth: monthParam(params, "toCal"),
      view: viewParam(params),
    };

    return htmlResponse(
      adminLedgerPage(
        {
          dates,
          filters,
          groups: groupOptions,
          listings: listingOptions,
          names,
          returnUrl: url.pathname + url.search,
          stats: stats.rows,
          statsHeading: stats.heading,
          today,
          transfers,
          truncated,
        },
        session,
      ),
    );
  });
