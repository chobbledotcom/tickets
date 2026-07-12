import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin ledger routes: owner-only ledger views plus the narrow maintenance
 * forms for owner-entered corrections.
 *
 *   GET  /admin/ledger                    — the recent transfer list
 *   GET  /admin/ledger/:type/:ref         — one account's statement
 *   GET  /admin/ledger/:type/:ref/add     — add an owner-entered entry
 *   GET  /admin/ledger/entries/:id/edit   — edit or delete one entry
 *   POST /admin/ledger/:type/:ref/add     — post an owner-entered entry
 *   POST /admin/ledger/entries/:id/edit   — update amount/time
 *   POST /admin/ledger/entries/:id/delete — delete an entry
 *
 * The account segment is named `:ref`, not `:id`, on purpose: the router parses
 * an `id`/`*Id` param as digits-only, but a singleton account's id is a word
 * (`external`→`world`, `fee_income`→`booking`), so a digits-only pattern would
 * 404 those statements before the handler ran. `:ref` matches any non-slash
 * segment, and {@link accountFromRoute} validates it per account type.
 *
 * All routes are owner-only (the ledger exposes every account's money
 * movements). The feature layer loads the transfers, builds the
 * {@link LedgerNames} id→name
 * lookup for the accounts those transfers reference (decrypting attendee names
 * with the session key, exactly as the activity log does, and reading
 * listing/modifier names from their loaders), and hands them to the shared
 * renderer. `memo` is deliberately never loaded for display — it may be
 * owner-encrypted free text, and rendering it is out of scope.
 */

import * as v from "valibot";
import { mapNotNullish, sort, unique } from "#fp";
import { t } from "#i18n";
import { loadAttendeeNames } from "#routes/admin/actions.ts";
/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import {
  type AuthSession,
  OWNER_FORM,
  requireOwnerOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
/* jscpd:ignore-end */
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  ATTENDEE,
  COST,
  isRowAccountType,
  isSingletonAccountType,
  MODIFIER,
  REVENUE,
  ROW_ACCOUNT_CONSTRUCTORS,
  SINGLETON_ACCOUNTS,
} from "#shared/accounting/accounts.ts";
import {
  type ListingMoneyTotals,
  listingMoneyTotals,
} from "#shared/accounting/listing-money-totals.ts";
import {
  deleteManualLedgerEntry,
  getTransferById,
  isManualLedgerEntryType,
  isManualLedgerTransfer,
  manualLedgerEntryOptionsFor,
  postManualLedgerEntry,
  updateManualLedgerEntry,
} from "#shared/accounting/manual-entries.ts";
import {
  ledgerTotals,
  transferActivityBounds,
  transfersByAccount,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import type { LedgerRange } from "#shared/accounting/range.ts";
import {
  formatCurrency,
  formatSignedCurrency,
  toMajorUnits,
} from "#shared/currency.ts";
import { addDays, dateRange, formatDateLabel } from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllGroupNames, getListingsByGroupId } from "#shared/db/groups.ts";
import { getAllListings, getListingNamesByIds } from "#shared/db/listings.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import {
  dayStartEpochMs,
  epochMsToTzDate,
  localToUtc,
  todayInTz,
  utcToLocalInput,
} from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { isIsoDate, isIsoMonth } from "#shared/validation/date.ts";
import { parsePositiveMinorUnits } from "#shared/validation/money.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  adminLedgerEntryAddPage,
  adminLedgerEntryEditPage,
  type LedgerEntryAddOption,
  type LedgerEntryFormValues,
} from "#templates/admin/ledger/entry-pages.tsx";
import {
  type LedgerFilterState,
  type LedgerGroupOption,
  type LedgerListingOption,
  type LedgerViewMode,
  LedgerViewModeSchema,
} from "#templates/admin/ledger/filter.tsx";
import {
  type AccountLedgerData,
  adminAccountStatementPage,
} from "#templates/admin/ledger/statement.tsx";
import {
  adminLedgerPage,
  type LedgerNames,
  rowAccountNames,
} from "#templates/admin/ledger.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";

/** How many of the most recent transfers the historical list shows. Older legs
 * are dropped and a "showing recent" note surfaces, mirroring the global log. */
export const LEDGER_DISPLAY_LIMIT = 500;

/** The distinct numeric ids of one row-backed account type referenced by a set
 * of accounts. A singleton like `external:world` has a non-numeric id, so it
 * never contributes. */
const referencedAccountIds = (accounts: AccountRef[], type: string): number[] =>
  unique(
    mapNotNullish((account: AccountRef) =>
      account.type === type ? Number(account.id) : null,
    )(accounts),
  );

/**
 * Build the id→name lookup for every row-backed account a slice of transfers
 * references. Attendee names are decrypted with the current request's key (only
 * when an attendee is actually referenced, so a ledger of system-only legs never
 * forces a key derivation); listing and modifier names come from their loaders.
 * An entity that has since been deleted simply has no entry — its legs render as
 * plain text, no link.
 */
export const loadLedgerNamesForAccounts = async (
  accounts: AccountRef[],
): Promise<LedgerNames> => {
  const attendeeIds = referencedAccountIds(accounts, ATTENDEE);
  // A listing is named by BOTH its accounts: revenue legs and servicing-cost
  // legs each resolve to the listing row's name.
  const listingIds = unique([
    ...referencedAccountIds(accounts, REVENUE),
    ...referencedAccountIds(accounts, COST),
  ]);
  const modifierIds = new Set(referencedAccountIds(accounts, MODIFIER));
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

/** Every account a slice of transfers touches, as source or destination. */
const accountsOf = (transfers: Transfer[]): AccountRef[] =>
  transfers.flatMap((transfer) => [transfer.source, transfer.destination]);

export const loadLedgerNames = (transfers: Transfer[]): Promise<LedgerNames> =>
  loadLedgerNamesForAccounts(accountsOf(transfers));

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
const monthParam = validatedParam(isIsoMonth);

/** Parse the `?listing=` scope: a positive integer, else null ("all listings"). */
const listingParam = (params: URLSearchParams): number | null => {
  const value = params.get("listing");
  return value ? parsePositiveIntId(value) : null;
};

const groupParam = (params: URLSearchParams): number | null => {
  const value = params.get("group");
  return value ? parsePositiveIntId(value) : null;
};

/** Parse the `?view=` mode via its picklist, defaulting to the human view. */
const viewParam = (params: URLSearchParams): LedgerViewMode => {
  const parsed = v.safeParse(LedgerViewModeSchema, params.get("view"));
  return parsed.success ? parsed.output : "human";
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
const moneyRow = (key: string, amount: number, signed = false): DetailRow => ({
  key: t(key),
  value: formatSignedCurrency(amount, signed),
});

const listingMoneyRows = (money: ListingMoneyTotals): DetailRow[] => [
  moneyRow("admin.ledger.stats.gross_sales", money.grossSales, true),
  moneyRow("admin.ledger.stats.recognised_income", money.income, true),
  moneyRow("admin.ledger.stats.servicing_costs", -money.servicingCosts, true),
  moneyRow("admin.ledger.stats.refunded", -money.refunds, true),
  moneyRow("admin.ledger.stats.external_costs", -money.externalCosts, true),
  moneyRow(
    "admin.ledger.stats.net_after_costs",
    money.income - money.refunds - money.externalCosts - money.servicingCosts,
  ),
];

/** The range-scoped stats and their heading. "All listings" shows the four
 *  business-wide totals; a chosen listing shows that listing's revenue
 *  breakdown, so the figures always match the scope the list is filtered to. */
const buildStats = async (
  range: LedgerRange,
  listingId: number | null,
  groupId: number | null,
  listings: ListingWithCount[],
  groupListings: ListingWithCount[],
  groupNames: Map<number, string>,
): Promise<{ rows: DetailRow[]; heading: string | null }> => {
  if (listingId !== null) {
    const money = await listingMoneyTotals(range, [listingId]);
    // The caller only scopes to a listing it found in this same cached list, so
    // the lookup always resolves.
    const listing = listings.find((entry) => entry.id === listingId)!;
    return {
      heading: listing.name,
      rows: listingMoneyRows(money),
    };
  }
  if (groupId !== null) {
    const money = await listingMoneyTotals(
      range,
      groupListings.map((listing) => listing.id),
    );
    // The caller only scopes to a group it found in this same cached map, so the
    // lookup always resolves.
    return {
      heading: groupNames.get(groupId)!,
      rows: listingMoneyRows(money),
    };
  }
  const totals = await ledgerTotals(range);
  // No heading for the whole-business view — the page is already titled Ledger.
  return {
    heading: null,
    rows: [
      moneyRow("admin.ledger.stats.income", totals.income, true),
      moneyRow("admin.ledger.stats.due", totals.due),
      moneyRow("admin.ledger.stats.refunded", -totals.refunded, true),
      moneyRow("admin.ledger.stats.fees", totals.fees, true),
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
    const requested = listingParam(params);
    const listingId =
      requested !== null && listings.some((listing) => listing.id === requested)
        ? requested
        : null;
    const requestedGroup = groupParam(params);
    const groupId =
      listingId === null &&
      requestedGroup !== null &&
      groupNames.has(requestedGroup)
        ? requestedGroup
        : null;
    const groupListings =
      groupId === null ? [] : await getListingsByGroupId(groupId);
    const listingIds =
      listingId === null
        ? groupId === null
          ? null
          : groupListings.map((listing) => listing.id)
        : [listingId];

    const fetched = await visibleTransfers(
      range,
      listingIds,
      LEDGER_DISPLAY_LIMIT + 1,
    );
    const truncated = fetched.length > LEDGER_DISPLAY_LIMIT;
    const transfers = truncated
      ? fetched.slice(0, LEDGER_DISPLAY_LIMIT)
      : fetched;

    const [names, stats, dates] = await Promise.all([
      loadLedgerNames(transfers),
      buildStats(
        range,
        listingId,
        groupId,
        listings,
        groupListings,
        groupNames,
      ),
      buildPickerDates(tz, today),
    ]);

    const listingOptions: LedgerListingOption[] = sort(
      (a: LedgerListingOption, b: LedgerListingOption) =>
        a.name.localeCompare(b.name),
    )(listings.map((listing) => ({ id: listing.id, name: listing.name })));
    const groupOptions: LedgerGroupOption[] = sort(
      (a: LedgerGroupOption, b: LedgerGroupOption) =>
        a.name.localeCompare(b.name),
    )([...groupNames].map(([id, name]) => ({ id, name })));

    const filters: LedgerFilterState = {
      from,
      fromMonth: monthParam(params, "fromCal"),
      groupId,
      listingId,
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

/** Build the {@link AccountRef} for a `:type`/`:ref` route pair, or null when
 * the type is unknown or a row-backed ref is not a positive integer. Singletons
 * map to their fixed account regardless of the `:ref` segment. Dispatch is the
 * two exhaustive registries in the chart of accounts, so a new account type
 * gets a statement route by declaring itself there — never by adding an arm
 * here. */
export const accountFromRoute = (
  type: string,
  ref: string,
): AccountRef | null => {
  if (isSingletonAccountType(type)) return SINGLETON_ACCOUNTS[type];
  if (!isRowAccountType(type)) return null;
  const id = parsePositiveIntId(ref);
  return id === null ? null : ROW_ACCOUNT_CONSTRUCTORS[type](id);
};

/** Load one account's full statement and the labels for both that account and
 * every counterparty it touches. Shared by standalone statements and the
 * attendee/listing/modifier embedded panels. */
export const loadAccountLedger = async (
  account: AccountRef,
): Promise<AccountLedgerData> => {
  const transfers = await transfersByAccount(account);
  return {
    account,
    lines: statementFor(account)(transfers),
    names: await loadLedgerNamesForAccounts([
      account,
      ...accountsOf(transfers),
    ]),
  };
};

const ownerHtml = (
  request: Request,
  render: (session: AuthSession) => string | null | Promise<string | null>,
): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const html = await render(session);
    return html === null ? notFoundResponse() : htmlResponse(html);
  });

type TypeRefParams = { ref: string; type: string };

const ownerTypeRefHtml =
  (
    render: (
      request: Request,
      session: AuthSession,
      params: TypeRefParams,
    ) => string | null | Promise<string | null>,
  ) =>
  (request: Request, params: TypeRefParams): Promise<Response> =>
    ownerHtml(request, (session) => render(request, session, params));

/**
 * Handle GET /admin/ledger/:type/:id — one account's full running-balance
 * statement. 404s on an unknown account type or a bad row id. No opening
 * balance: this is the account's whole history, so the running total starts at
 * zero by construction.
 */
export const handleAccountStatementGet: TypedRouteHandler<"GET /admin/ledger/:type/:ref"> =
  ownerTypeRefHtml(async (_request, session, { type, ref }) => {
    const account = accountFromRoute(type, ref);
    if (!account) return null;
    const { lines, names } = await loadAccountLedger(account);
    return adminAccountStatementPage(account, lines, names, session);
  });

const pathFromUrlValue = (value: string | null, fallback: string): string => {
  if (!value || !URL.canParse(value, "http://localhost")) return fallback;
  const url = new URL(value, "http://localhost");
  return `${url.pathname}${url.search}${url.hash}`;
};

const returnUrlFromRequest = (request: Request, fallback: string): string =>
  pathFromUrlValue(
    new URL(request.url).searchParams.get("return_url"),
    fallback,
  );

const returnUrlFromForm = (form: FormParams, fallback: string): string =>
  pathFromUrlValue(form.getString("return_url"), fallback);

const editEntryPath = (id: number, returnUrl: string): string =>
  `/admin/ledger/entries/${id}/edit?return_url=${encodeURIComponent(returnUrl)}`;

const addEntryPath = (account: AccountRef, returnUrl: string): string =>
  `/admin/ledger/${account.type}/${account.id}/add?return_url=${encodeURIComponent(
    returnUrl,
  )}`;

// A manual ledger entry takes a strictly positive amount — the same
// currency-aware money parse the rest of the app uses.
const parseAmount = (form: FormParams): number | null =>
  parsePositiveMinorUnits(form.getString("amount"));

const parseOccurredAt = (form: FormParams): string | null => {
  const raw = form.getString("occurred_at").trim();
  if (!raw) return null;
  try {
    return localToUtc(raw, settings.timezone);
  } catch {
    return null;
  }
};

type ParsedEntryFields = { amount: number; occurredAt: string };

const parseLedgerEntryFields = (
  form: FormParams,
  redirectUrl: string,
): ParsedEntryFields | Response => {
  const amount = parseAmount(form);
  if (amount === null)
    return errorRedirect(redirectUrl, "Enter a valid amount");
  const occurredAt = parseOccurredAt(form);
  if (occurredAt === null) {
    return errorRedirect(redirectUrl, "Enter a valid timestamp");
  }
  return { amount, occurredAt };
};

const transferFormValues = (transfer: Transfer): LedgerEntryFormValues => ({
  amount: toMajorUnits(transfer.amount),
  occurredAt: utcToLocalInput(transfer.occurredAt, settings.timezone),
});

const blankEntryValues = (
  options: LedgerEntryAddOption[],
): LedgerEntryFormValues => ({
  amount: "",
  entryType: options[0]?.type,
  occurredAt: utcToLocalInput(nowIso(), settings.timezone),
});

const addOptions = (account: AccountRef): LedgerEntryAddOption[] =>
  manualLedgerEntryOptionsFor(account).map((option) => ({
    ...option,
    hint: t(option.hintKey),
    label: t(option.labelKey),
  }));

/**
 * Resolve an account an owner-entered entry may be added to: the account
 * exists, its row still exists (its name resolves), and the manual-entry spec
 * table offers at least one entry type for it. Addability is thereby driven by
 * that spec table — an account type gains an add form by gaining specs, never
 * by another parallel type list here.
 */
const loadAddableAccount = async (
  type: string,
  ref: string,
): Promise<{
  account: AccountRef;
  names: LedgerNames;
  options: LedgerEntryAddOption[];
} | null> => {
  const account = accountFromRoute(type, ref);
  if (!account || !isRowAccountType(account.type)) return null;
  const options = addOptions(account);
  if (options.length === 0) return null;
  const names = await loadLedgerNamesForAccounts([account]);
  return rowAccountNames(account.type, names).has(Number(account.id))
    ? { account, names, options }
    : null;
};

type OwnerLedgerFormHandler = (
  session: AuthSession,
  form: FormParams,
) => Response | Promise<Response>;

const ownerLedgerForm = (
  request: Request,
  handler: OwnerLedgerFormHandler,
): Promise<Response> => withAuth(request, OWNER_FORM, handler);

const accountStatementPath = (account: AccountRef): string =>
  `/admin/ledger/${account.type}/${account.id}`;

const getEditableTransferById = async (
  id: number,
): Promise<Transfer | null> => {
  const transfer = await getTransferById(id);
  return transfer && isManualLedgerTransfer(transfer) ? transfer : null;
};

const editPostedTransfer = async (
  id: number,
  form: FormParams,
): Promise<{
  transfer: Transfer;
  returnUrl: string;
  redirectUrl: string;
} | null> => {
  const transfer = await getEditableTransferById(id);
  if (!transfer) return null;
  const returnUrl = returnUrlFromForm(form, "/admin/ledger");
  return { redirectUrl: editEntryPath(id, returnUrl), returnUrl, transfer };
};

type PostedTransfer = {
  transfer: Transfer;
  returnUrl: string;
  redirectUrl: string;
};

const ownerPostedTransferForm = (
  request: Request,
  id: number,
  handler: (
    posted: PostedTransfer,
    form: FormParams,
  ) => Response | Promise<Response>,
): Promise<Response> =>
  ownerLedgerForm(request, async (_session, form) => {
    const posted = await editPostedTransfer(id, form);
    return posted ? handler(posted, form) : notFoundResponse();
  });

type PostedTransferHandler = (
  posted: PostedTransfer,
  form: FormParams,
) => Response | Promise<Response>;

const postedTransferRoute =
  (handler: PostedTransferHandler) =>
  (request: Request, params: { id: number }): Promise<Response> =>
    ownerPostedTransferForm(request, params.id, handler);

export const handleLedgerEntryAddGet: TypedRouteHandler<"GET /admin/ledger/:type/:ref/add"> =
  ownerTypeRefHtml(async (request, session, { type, ref }) => {
    const loaded = await loadAddableAccount(type, ref);
    if (!loaded) return null;
    const flash = applyFlash(request);
    return adminLedgerEntryAddPage({
      ...loaded,
      error: flash.error,
      returnUrl: returnUrlFromRequest(
        request,
        accountStatementPath(loaded.account),
      ),
      session,
      values: blankEntryValues(loaded.options),
    });
  });

export const handleLedgerEntryAddPost: TypedRouteHandler<
  "POST /admin/ledger/:type/:ref/add"
> = (request, { type, ref }) =>
  ownerLedgerForm(request, async (session, form) => {
    const loaded = await loadAddableAccount(type, ref);
    if (!loaded) return notFoundResponse();
    const returnUrl = returnUrlFromForm(
      form,
      accountStatementPath(loaded.account),
    );
    const redirectUrl = addEntryPath(loaded.account, returnUrl);
    const entryType = form.getString("entry_type");
    if (
      !isManualLedgerEntryType(entryType) ||
      !loaded.options.some((option) => option.type === entryType)
    ) {
      return errorRedirect(redirectUrl, "Choose what happened");
    }
    const parsed = parseLedgerEntryFields(form, redirectUrl);
    if (parsed instanceof Response) return parsed;
    await postManualLedgerEntry({
      account: loaded.account,
      amount: parsed.amount,
      occurredAt: parsed.occurredAt,
      postedBy: String(session.userId),
      type: entryType,
    });
    await logActivity("Manual ledger entry added");
    return redirect(returnUrl, "Ledger entry added", true);
  });

export const handleLedgerEntryEditGet: TypedRouteHandler<
  "GET /admin/ledger/entries/:id/edit"
> = (request, { id }) =>
  ownerHtml(request, async (session) => {
    const transfer = await getEditableTransferById(id);
    if (!transfer) return null;
    const flash = applyFlash(request);
    const returnUrl = returnUrlFromRequest(request, "/admin/ledger");
    return adminLedgerEntryEditPage({
      error: flash.error,
      names: await loadLedgerNames([transfer]),
      returnUrl,
      session,
      transfer,
      values: transferFormValues(transfer),
    });
  });

const updatePostedTransfer: PostedTransferHandler = async (posted, form) => {
  const parsed = parseLedgerEntryFields(form, posted.redirectUrl);
  if (parsed instanceof Response) return parsed;
  await updateManualLedgerEntry(
    posted.transfer,
    parsed.amount,
    parsed.occurredAt,
  );
  await logActivity(`Ledger entry #${posted.transfer.id} updated`);
  return redirect(posted.returnUrl, "Ledger entry updated", true);
};

const deletePostedTransfer: PostedTransferHandler = async (posted, form) => {
  const error = verifyOrRedirect(
    form,
    formatCurrency(posted.transfer.amount),
    posted.redirectUrl,
    "Amount",
    "deletion",
  );
  if (error) return error;
  await deleteManualLedgerEntry(posted.transfer);
  await logActivity(`Ledger entry #${posted.transfer.id} deleted`);
  return redirect(posted.returnUrl, "Ledger entry deleted", true);
};

export const handleLedgerEntryEditPost: TypedRouteHandler<"POST /admin/ledger/entries/:id/edit"> =
  postedTransferRoute(updatePostedTransfer);

export const handleLedgerEntryDeletePost: TypedRouteHandler<"POST /admin/ledger/entries/:id/delete"> =
  postedTransferRoute(deletePostedTransfer);

/** Ledger routes (owner-only). */
export const adminHandlers = handlersFor("ledger")({
  getLedger: handleLedgerGet,
  getLedgerByTypeByRef: handleAccountStatementGet,
  getLedgerByTypeByRefAdd: handleLedgerEntryAddGet,
  getLedgerEntriesByIdEdit: handleLedgerEntryEditGet,
  postLedgerByTypeByRefAdd: handleLedgerEntryAddPost,
  postLedgerEntriesByIdDelete: handleLedgerEntryDeletePost,
  postLedgerEntriesByIdEdit: handleLedgerEntryEditPost,
});
