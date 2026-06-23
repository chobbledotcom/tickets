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

import { mapNotNullish, unique } from "#fp";
import { loadAttendeeNames } from "#routes/admin/actions.ts";
import { type AuthSession, requireOwnerOr } from "#routes/auth.ts";
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
  recentTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { getListingNamesByIds } from "#shared/db/listings.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import {
  adminAccountStatementPage,
  adminLedgerPage,
  type LedgerNames,
} from "#templates/admin/ledger.tsx";

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
 * references. Attendee names are decrypted with the session key (only when an
 * attendee is actually referenced, so a ledger of system-only legs never forces
 * a key prompt); listing and modifier names come from their loaders. An entity
 * that has since been deleted simply has no entry — its legs render as plain
 * text, no link.
 */
export const loadLedgerNames = async (
  transfers: Transfer[],
  session: AuthSession,
): Promise<LedgerNames> => {
  const attendeeIds = referencedIds(transfers, "attendee");
  const listingIds = referencedIds(transfers, "revenue");
  const modifierIds = new Set(referencedIds(transfers, "modifier"));
  const [attendees, listings, modifiers] = await Promise.all([
    loadAttendeeNames(attendeeIds, session),
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

/** Handle GET /admin/ledger — the recent historical transfer list. The query
 * fetches one extra row past the display cap: getting more than the cap means
 * older legs were dropped, so the "showing recent" note is shown and only the
 * first {@link LEDGER_DISPLAY_LIMIT} rows are rendered. Rows arrive newest-first
 * from SQL, so no in-memory sort is needed. */
export const handleLedgerGet: TypedRouteHandler<"GET /admin/ledger"> = (
  request,
) =>
  requireOwnerOr(request, async (session) => {
    const fetched = await recentTransfers(LEDGER_DISPLAY_LIMIT + 1);
    const truncated = fetched.length > LEDGER_DISPLAY_LIMIT;
    const transfers = truncated
      ? fetched.slice(0, LEDGER_DISPLAY_LIMIT)
      : fetched;
    const names = await loadLedgerNames(transfers, session);
    return htmlResponse(adminLedgerPage(transfers, names, truncated, session));
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
    const names = await loadLedgerNames(transfers, session);
    return htmlResponse(
      adminAccountStatementPage(account, lines, names, session),
    );
  });

/** Ledger routes (owner-only). */
export const ledgerRoutes = defineRoutes({
  "GET /admin/ledger": handleLedgerGet,
  "GET /admin/ledger/:type/:ref": handleAccountStatementGet,
});
