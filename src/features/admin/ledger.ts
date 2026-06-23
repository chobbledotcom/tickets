/**
 * Admin "ledger" routes — the read-only view of the `transfers` ledger.
 *
 *   GET /admin/ledger             — the recent historical transfer list
 *   GET /admin/ledger/:type/:ref  — one account's running-balance statement
 *
 * The account segment is named `:ref`, not `:id`, on purpose: the router parses
 * an `id`/`*Id` param as digits-only, but a singleton account's id is a word
 * (`external`→`world`, `fee_income`→`booking`), so a digits-only pattern would
 * 404 those statements before the handler ran. `:ref` matches any non-slash
 * segment, and {@link accountFromRoute} validates it per account type.
 *
 * Both are owner-only (the ledger exposes every account's money movements). The
 * feature layer loads the transfers, builds the {@link LedgerNames} id→name
 * lookup for the accounts those transfers reference (decrypting attendee names
 * with the session key, exactly as the activity log does, and reading
 * listing/modifier names from their loaders), and hands them to the shared
 * renderer. `memo` is deliberately never loaded for display — it may be
 * owner-encrypted free text, and rendering it is out of scope.
 */

import { mapNotNullish, sort, unique } from "#fp";
import { t } from "#i18n";
import { loadAttendeeNames } from "#routes/admin/actions.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
  WRITEOFF,
} from "#shared/accounting/accounts.ts";
import {
  ledgerTotals,
  transferActivityBounds,
  transfersByAccount,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import type { LedgerRange } from "#shared/accounting/range.ts";
import { formatCurrency } from "#shared/currency.ts";
import { addDays, dateRange, formatDateLabel } from "#shared/dates.ts";
import {
  getAllListings,
  getListingNamesByIds,
  listingRevenueBreakdown,
} from "#shared/db/listings.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import {
  dayStartEpochMs,
  epochMsToTzDate,
  todayInTz,
} from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  adminAccountStatementPage,
  adminLedgerPage,
  type LedgerFilterState,
  type LedgerListingOption,
  type LedgerNames,
} from "#templates/admin/ledger.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";

/** How many of the most recent transfers the historical list shows. Older legs
 * are dropped and a "showing recent" note surfaces, mirroring the global log. */
export const LEDGER_DISPLAY_LIMIT = 500;

/** The distinct numeric ids of one row-backed account type referenced by a slice
 * of transfers (as either leg). A singleton like `external:world` has a
 * non-numeric id, so it never contributes. */
const referencedIds = (transfers: Transfer[], type: string): number[] =>
  unique(
    mapNotNullish((account: AccountRef) =>
      account.type === type ? Number(account.id) : null,
    )([
      ...transfers.map((tx) => tx.source),
      ...transfers.map((tx) => tx.destination),
    ]),
  );

/**
 * Build the id→name lookup for every row-backed account a slice of transfers
 * references. Attendee names are decrypted with the current request's key (only
 * when an attendee is actually referenced, so a ledger of system-only legs never
 * forces a key derivation); listing and modifier names come from their loaders.
 * An entity that has since been deleted simply has no entry — its legs render as
 * plain text, no link.
 */
export const loadLedgerNames = async (
  transfers: Transfer[],
): Promise<LedgerNames> => {
  const attendeeIds = referencedIds(transfers, "attendee");
  const listingIds = referencedIds(transfers, "revenue");
  const modifierIds = new Set(referencedIds(transfers, "modifier"));
  const [attendees, listings, modifiers] = await Promise.all([
    loadAttendeeNames(attendeeIds),
    getListingNamesByIds(listingIds),
    modifierIds.size > 0 ? getAllModifiers() : Promise.resolve([]),
  ]);
  return {
    attendees,
    listings,
    modifiers: new Map(
      modifiers
        .filter((modifier) => modifierIds.has(modifier.id))
        .map((modifier) => [modifier.id, modifier.name]),
    ),
  };
};

/** A query-param reader that yields the value only when it passes `valid`, else
 *  null — the shared shape of the date and paged-month param parsers. */
const validatedParam =
  (valid: (value: string) => boolean) =>
  (params: URLSearchParams, key: string): string | null => {
    const value = params.get(key);
    return value && valid(value) ? value : null;
  };

/** Parse a validated `YYYY-MM-DD` query param, or null when absent/invalid. */
const dateParam = validatedParam(isIsoDate);

/** Parse a validated `YYYY-MM` (paged-month) query param, or null. */
const monthParam = validatedParam((value) => /^\d{4}-\d{2}$/.test(value));

/** Parse the `?listing=` scope: a positive integer, else null ("all listings"). */
const listingParam = (params: URLSearchParams): number | null => {
  const value = params.get("listing");
  if (!value) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** Turn a `from`/`to` day filter into the epoch-ms range the ledger queries
 *  bound against: `from` at the start of its day, `to` exclusive at the start of
 *  the FOLLOWING day so the whole `to` day is included. Site-timezone aware. */
const filterRange = (
  from: string | null,
  to: string | null,
  tz: string,
): LedgerRange => ({
  endMs: to ? dayStartEpochMs(addDays(to, 1), tz) : null,
  startMs: from ? dayStartEpochMs(from, tz) : null,
});

/** The dates the range pickers offer as selectable: every day from the earliest
 *  transfer to the later of the latest transfer and today (so a future bound is
 *  still pickable). Empty when the ledger holds no transfers. */
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

/** Load the ledger's activity bounds and turn them into the selectable picker
 *  dates for the operator's timezone and today. */
const buildPickerDates = async (
  tz: string,
  today: string,
): Promise<DatePickerDate[]> =>
  pickerDatesFromBounds(await transferActivityBounds(), today, tz);

/** A single key/value stats row, currying the currency formatting at each call. */
const moneyRow = (key: string, amount: number): DetailRow => ({
  key: t(key),
  value: formatCurrency(amount),
});

/** The range-scoped stats and their heading. "All listings" shows the four
 *  business-wide totals; a chosen listing shows that listing's revenue
 *  breakdown, so the figures always match the scope the list is filtered to. */
const buildStats = async (
  range: LedgerRange,
  listingId: number | null,
  listings: ListingWithCount[],
): Promise<{ rows: DetailRow[]; heading: string }> => {
  if (listingId === null) {
    const totals = await ledgerTotals(range);
    return {
      heading: t("admin.ledger.stats.all_heading"),
      rows: [
        moneyRow("admin.ledger.stats.income", totals.income),
        moneyRow("admin.ledger.stats.due", totals.due),
        moneyRow("admin.ledger.stats.refunded", totals.refunded),
        moneyRow("admin.ledger.stats.fees", totals.fees),
      ],
    };
  }
  const breakdown = await listingRevenueBreakdown(listingId, range);
  // The caller only scopes to a listing it found in this same cached list, so the
  // lookup always resolves — trust that invariant rather than guard an
  // impossible miss.
  const listing = listings.find((entry) => entry.id === listingId)!;
  return {
    heading: listing.name,
    rows: [
      moneyRow("admin.ledger.stats.gross_sales", breakdown.grossSales),
      moneyRow(
        "admin.ledger.stats.recognised_income",
        breakdown.recognisedIncome,
      ),
      moneyRow("admin.ledger.stats.refunded", breakdown.refunds),
      moneyRow("admin.ledger.stats.net_balance", breakdown.netBalance),
    ],
  };
};

/**
 * Handle GET /admin/ledger — the operator ledger: a range-scoped stats table, a
 * from/to date-range filter and a by-listing select, then the visible transfer
 * list. The list query fetches one extra row past {@link LEDGER_DISPLAY_LIMIT} so
 * truncation is detected (the "showing recent" note shows and only the cap
 * renders). Rows arrive newest-first from SQL. Cash (`external`) legs are hidden.
 */
export const handleLedgerGet: TypedRouteHandler<"GET /admin/ledger"> = (
  request,
) =>
  requireOwnerOr(request, async (session) => {
    const params = new URL(request.url).searchParams;
    const from = dateParam(params, "from");
    const to = dateParam(params, "to");
    const tz = settings.timezone;
    const today = todayInTz(tz);
    const range = filterRange(from, to, tz);

    const listings = await getAllListings();
    const requested = listingParam(params);
    const listingId =
      requested !== null && listings.some((listing) => listing.id === requested)
        ? requested
        : null;

    const fetched = await visibleTransfers(
      range,
      listingId,
      LEDGER_DISPLAY_LIMIT + 1,
    );
    const truncated = fetched.length > LEDGER_DISPLAY_LIMIT;
    const transfers = truncated
      ? fetched.slice(0, LEDGER_DISPLAY_LIMIT)
      : fetched;

    const [names, stats, dates] = await Promise.all([
      loadLedgerNames(transfers),
      buildStats(range, listingId, listings),
      buildPickerDates(tz, today),
    ]);

    const listingOptions: LedgerListingOption[] = sort(
      (a: LedgerListingOption, b: LedgerListingOption) =>
        a.name.localeCompare(b.name),
    )(listings.map((listing) => ({ id: listing.id, name: listing.name })));

    const filters: LedgerFilterState = {
      from,
      fromMonth: monthParam(params, "fromCal"),
      listingId,
      to,
      toMonth: monthParam(params, "toCal"),
    };

    return htmlResponse(
      adminLedgerPage(
        {
          dates,
          filters,
          listings: listingOptions,
          names,
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

/** Build the {@link AccountRef} for a `:type`/`:ref` route pair, or null when the
 * type is unknown or a row-backed ref is not a positive integer. Singletons map
 * to their fixed account regardless of the `:ref` segment. */
export const accountFromRoute = (
  type: string,
  ref: string,
): AccountRef | null => {
  if (type === "external") return WORLD;
  if (type === "fee_income") return BOOKING_FEE_INCOME;
  if (type === "writeoff") return WRITEOFF;
  const makeAccount = ROW_ACCOUNT_CONSTRUCTORS[type];
  if (!makeAccount) return null;
  const numericId = Number(ref);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  return makeAccount(numericId);
};

/** Row-backed account constructors keyed by route `:type`. */
const ROW_ACCOUNT_CONSTRUCTORS: Record<string, (id: number) => AccountRef> = {
  attendee: attendeeAccount,
  modifier: modifierAccount,
  revenue: revenueAccount,
};

/**
 * Handle GET /admin/ledger/:type/:id — one account's full running-balance
 * statement. 404s on an unknown account type or a bad row id. No opening
 * balance: this is the account's whole history, so the running total starts at
 * zero by construction.
 */
export const handleAccountStatementGet: TypedRouteHandler<
  "GET /admin/ledger/:type/:ref"
> = (request, { type, ref }) =>
  requireOwnerOr(request, async (session) => {
    const account = accountFromRoute(type, ref);
    if (!account) return notFoundResponse();
    const transfers = await transfersByAccount(account);
    const lines = statementFor(account)(transfers);
    const names = await loadLedgerNames(transfers);
    return htmlResponse(
      adminAccountStatementPage(account, lines, names, session),
    );
  });

/** Ledger routes (owner-only). */
export const ledgerRoutes = defineRoutes({
  "GET /admin/ledger": handleLedgerGet,
  "GET /admin/ledger/:type/:ref": handleAccountStatementGet,
});
