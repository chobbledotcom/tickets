/**
 * Shared "ledger" renderer — the one read-only view of the `transfers` ledger,
 * used across three admin surfaces (decision 15):
 * the historical transfer list (`/admin/ledger`), a single account's
 * running-balance statement (`/admin/ledger/:type/:id`), and the per-attendee
 * statement panel embedded on the edit-attendee page.
 *
 * Like the activity log, the template is render-only: the feature layer builds a
 * {@link LedgerNames} id→name lookup (decrypting attendee names with the session
 * key, reading listing/modifier names from their loaders) so an account leg can
 * be shown as a link without this module touching the database. An id absent
 * from the map (a deleted entity that still keeps its ledger rows) falls back to
 * plain "<Entity> #<id>" text with no link, mirroring the activity log.
 */

import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { Raw, type SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import { sameAccount } from "#shared/ledger/account.ts";
import type { StatementLine } from "#shared/ledger/project.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  type DetailRow,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink } from "#templates/components/actions.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";
import { Layout } from "#templates/layout.tsx";

/**
 * Display names for the row-backed account legs the ledger renders, each a
 * bounded id→name lookup the feature layer builds (attendee names decrypted with
 * the session key, listing/modifier names from their loaders). Mirrors the
 * activity log's `ActivityLogRefs`; an id missing from a map is a deleted entity
 * whose ledger rows survive, so its leg renders as plain text with no link.
 */
export interface LedgerNames {
  attendees: Map<number, string>;
  listings: Map<number, string>;
  modifiers: Map<number, string>;
}

/** An empty {@link LedgerNames}, for surfaces with no rows to label yet. */
export const emptyLedgerNames = (): LedgerNames => ({
  attendees: new Map(),
  listings: new Map(),
  modifiers: new Map(),
});

/** The resolved presentation of one account leg: the text to show, and the
 * detail-page href to link it to (absent for singletons and deleted entities). */
type AccountLabel = { text: string; href?: string };

/** One row-backed account type's resolver config: which names map to read, the
 * detail-page base path, and the i18n key for the "#<id>" deleted-entity
 * fallback. Currying over this keeps the three row-backed types identical. */
type RowAccountKind = {
  names: (refs: LedgerNames) => Map<number, string>;
  href: (id: number) => string;
  fallbackKey: string;
};

/** Row-backed account resolvers keyed by ledger account type. */
const ROW_ACCOUNT_KINDS: Record<string, RowAccountKind> = {
  attendee: {
    fallbackKey: "admin.ledger.fallback.attendee",
    href: (id) => `/admin/attendees/${id}`,
    names: (refs) => refs.attendees,
  },
  modifier: {
    fallbackKey: "admin.ledger.fallback.modifier",
    href: (id) => `/admin/modifiers/${id}/edit`,
    names: (refs) => refs.modifiers,
  },
  revenue: {
    fallbackKey: "admin.ledger.fallback.revenue",
    href: (id) => `/admin/listing/${id}`,
    names: (refs) => refs.listings,
  },
};

/** Singleton accounts get a friendly, link-free name from i18n, matched on the
 * account type alone (`writeoff:*` is one logical account regardless of id). */
const SINGLETON_LABEL_KEYS: Record<string, string> = {
  external: "admin.ledger.account.external",
  fee_income: "admin.ledger.account.fee_income",
  writeoff: "admin.ledger.account.writeoff",
};

/**
 * Resolve an account reference to its display text and optional detail link.
 * Singletons (`external:world`, `fee_income:booking`, `writeoff:*`) get a
 * friendly i18n name and never link. Row-backed accounts link to their entity by
 * name; when the id is absent from `names` (a deleted entity that kept its ledger
 * rows) the leg degrades to plain "<Entity> #<id>" with no link.
 */
export const resolveAccountLabel = (
  account: AccountRef,
  names: LedgerNames,
): AccountLabel => {
  const singleton = SINGLETON_LABEL_KEYS[account.type];
  if (singleton) return { text: t(singleton) };
  const kind = ROW_ACCOUNT_KINDS[account.type];
  if (!kind) return { text: `${account.type}:${account.id}` };
  const id = Number(account.id);
  const name = kind.names(names).get(id);
  return name === undefined
    ? { text: t(kind.fallbackKey, { id }) }
    : { href: kind.href(id), text: name };
};

/** One resolved account leg as cell content: a link when the entity exists,
 * plain (escaped) text otherwise. Interpolated (`{accountCell(...)}`) rather than
 * a `<Component/>` so the plain-text case can stay un-wrapped, like the activity
 * log's bare link cells. */
const accountCell = (
  account: AccountRef,
  names: LedgerNames,
): JSX.Element | string => {
  const { text, href } = resolveAccountLabel(account, names);
  return href === undefined ? text : <a href={href}>{text}</a>;
};

/** A transfer's kind, or an em dash when it carries none. */
const kindLabel = (transfer: Transfer): string => transfer.kind ?? "—";

/** One row of the historical transfer list. */
const LedgerRow = ({
  transfer,
  names,
}: {
  transfer: Transfer;
  names: LedgerNames;
}): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(transfer.occurredAt)}</td>
      <td>{kindLabel(transfer)}</td>
      <td>
        {accountCell(transfer.source, names)} &rarr;{" "}
        {accountCell(transfer.destination, names)}
      </td>
      <td class={colClass("amount")}>{formatCurrency(transfer.amount)}</td>
    </tr>,
  );

/** The historical transfer rows, or a single empty-state row spanning the table
 * when there are none — mirroring the activity log's empty row. */
const ledgerRows = (transfers: Transfer[], names: LedgerNames): string =>
  transfers.length > 0
    ? pipe(
        map((transfer: Transfer) => LedgerRow({ names, transfer })),
        joinStrings,
      )(transfers)
    : `<tr><td colspan="4">${t("admin.ledger.empty")}</td></tr>`;

/**
 * The historical transfer list: every leg as From → To with its kind, time, and
 * amount. Scrollable on narrow screens like the other admin tables.
 */
export const LedgerTable = ({
  transfers,
  names,
}: {
  transfers: Transfer[];
  names: LedgerNames;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>{t("admin.ledger.col.time")}</th>
          <th>{t("admin.ledger.col.event")}</th>
          <th>{t("admin.ledger.col.from_to")}</th>
          <th class={colClass("amount")}>{t("admin.ledger.col.amount")}</th>
        </tr>
      </thead>
      <tbody>
        <Raw html={ledgerRows(transfers, names)} />
      </tbody>
    </table>
  </div>
);

/** The signed delta of a statement line, formatted with an explicit sign so a
 * credit and a debit of the same magnitude never read alike. */
const signedAmount = (signed: number): string =>
  `${signed < 0 ? "-" : "+"}${formatCurrency(Math.abs(signed))}`;

/** The counterparty on a statement line: the OTHER account on the leg (the
 * source when this account received, else the destination). */
const counterparty = (line: StatementLine, account: AccountRef): AccountRef =>
  sameAccount(line.transfer.destination, account)
    ? line.transfer.source
    : line.transfer.destination;

/** One row of an account statement: time, kind, counterparty, signed delta, and
 * the running balance after the leg. */
const StatementRow = ({
  line,
  account,
  names,
}: {
  line: StatementLine;
  account: AccountRef;
  names: LedgerNames;
}): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(line.transfer.occurredAt)}</td>
      <td>{kindLabel(line.transfer)}</td>
      <td>{accountCell(counterparty(line, account), names)}</td>
      <td class={colClass("amount")}>{signedAmount(line.signed)}</td>
      <td class={colClass("amount")}>{formatCurrency(line.running)}</td>
    </tr>,
  );

/** The statement rows, or an empty-state row spanning the table when the account
 * has no history. */
const statementRows = (
  lines: StatementLine[],
  account: AccountRef,
  names: LedgerNames,
): string =>
  lines.length > 0
    ? pipe(
        map((line: StatementLine) => StatementRow({ account, line, names })),
        joinStrings,
      )(lines)
    : `<tr><td colspan="5">${t("admin.ledger.empty")}</td></tr>`;

/**
 * One account's running-balance statement: each leg as a counterparty plus the
 * signed delta and the balance after it. The account's own label and final
 * balance are shown by the caller as a heading; this is just the table.
 */
export const AccountStatementTable = ({
  account,
  lines,
  names,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>{t("admin.ledger.col.time")}</th>
          <th>{t("admin.ledger.col.event")}</th>
          <th>{t("admin.ledger.col.counterparty")}</th>
          <th class={colClass("amount")}>{t("admin.ledger.col.delta")}</th>
          <th class={colClass("amount")}>{t("admin.ledger.col.balance")}</th>
        </tr>
      </thead>
      <tbody>
        <Raw html={statementRows(lines, account, names)} />
      </tbody>
    </table>
  </div>
);

/** The plain display text for an account (no link), for headings/captions. */
export const accountLabelText = (
  account: AccountRef,
  names: LedgerNames,
): string => resolveAccountLabel(account, names).text;

/**
 * An account's heading: its display label and its current (final) balance. The
 * balance is the last statement line's running total, or zero for an account
 * with no history. Shared by the standalone statement page and the attendee
 * panel, so both read the balance the same way.
 */
export const AccountStatementHeading = ({
  account,
  lines,
  names,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
}): JSX.Element => {
  const balance = lines.length > 0 ? lines[lines.length - 1]!.running : 0;
  return (
    <p class="ledger-balance">
      <strong>{accountLabelText(account, names)}</strong>{" "}
      {t("admin.ledger.balance", { amount: formatCurrency(balance) })}
    </p>
  );
};

/**
 * The full per-account statement section (heading + table), reused by the
 * standalone statement page and the embedded attendee panel so both render the
 * account's balance and history identically.
 */
export const AccountStatementSection = ({
  account,
  lines,
  names,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
}): JSX.Element => (
  <>
    <AccountStatementHeading account={account} lines={lines} names={names} />
    <AccountStatementTable account={account} lines={lines} names={names} />
  </>
);

/** The whole filter state the ledger page round-trips through the query string:
 *  a `from`/`to` day range, an optional by-listing scope, and each picker's
 *  currently-paged month (so stepping months survives a reload). */
export type LedgerFilterState = {
  from: string | null;
  to: string | null;
  listingId: number | null;
  fromMonth: string | null;
  toMonth: string | null;
};

/** One option for the by-listing filter select. */
export type LedgerListingOption = { id: number; name: string };

/** Everything the (render-only) ledger page needs: the visible transfers and
 *  their name lookup, the range-scoped stats, the current filter state, and the
 *  data the two date pickers + listing select render from. */
export type LedgerPageData = {
  transfers: Transfer[];
  names: LedgerNames;
  truncated: boolean;
  stats: DetailRow[];
  statsHeading: string;
  filters: LedgerFilterState;
  dates: DatePickerDate[];
  today: string;
  listings: LedgerListingOption[];
};

/** Build a `/admin/ledger` URL from the current filters plus an override of any
 *  subset of them. A null/absent field drops its query param, so clearing the
 *  `from` date (override `{ from: null }`) yields a link without it. */
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
  }
  if (merged.fromMonth) params.set("fromCal", merged.fromMonth);
  if (merged.toMonth) params.set("toCal", merged.toMonth);
  const qs = params.toString();
  return `/admin/ledger${qs ? `?${qs}` : ""}${fragment}`;
};

/** One side of the date-range filter: which filter fields it reads and writes,
 *  so the two pickers share one renderer differing only by these accessors. */
type RangeSide = {
  anchorId: string;
  labelKey: string;
  pick: (f: LedgerFilterState) => { date: string | null; month: string | null };
  setDate: (v: string | null) => Partial<LedgerFilterState>;
  setMonth: (m: string) => Partial<LedgerFilterState>;
};

const RANGE_SIDES: RangeSide[] = [
  {
    anchorId: "ledger-from",
    labelKey: "admin.ledger.filter.from",
    pick: (f) => ({ date: f.from, month: f.fromMonth }),
    setDate: (v) => ({ from: v }),
    setMonth: (m) => ({ fromMonth: m }),
  },
  {
    anchorId: "ledger-to",
    labelKey: "admin.ledger.filter.to",
    pick: (f) => ({ date: f.to, month: f.toMonth }),
    setDate: (v) => ({ to: v }),
    setMonth: (m) => ({ toMonth: m }),
  },
];

/** One labelled date picker bound to one side of the range; both reuse the same
 *  `/admin/calendar` {@link DatePicker}, scoped to a unique anchor id. */
const RangeField = ({
  data,
  side,
}: {
  data: LedgerPageData;
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
        dayHref: (v) => ledgerHref(data.filters, side.setDate(v), fragment),
        monthHref: (m) => ledgerHref(data.filters, side.setMonth(m), fragment),
        selected: current.date,
        today: data.today,
        viewMonth: current.month,
      })}
    </div>
  );
};

/** The by-listing filter: a nav-select preselected to the current scope ("All
 *  listings" or one listing), each option navigating to the scoped ledger. */
const ListingFilter = ({ data }: { data: LedgerPageData }): SafeHtml => (
  <p class="table-header-actions">
    {t("admin.ledger.filter.listing")}:{" "}
    <select aria-label={t("admin.ledger.filter.listing")} data-nav-select>
      <option
        selected={data.filters.listingId === null}
        value={ledgerHref(data.filters, { listingId: null })}
      >
        {t("admin.ledger.filter.all_listings")}
      </option>
      {map(
        (listing: LedgerListingOption): SafeHtml => (
          <option
            selected={data.filters.listingId === listing.id}
            value={ledgerHref(data.filters, { listingId: listing.id })}
          >
            {listing.name}
          </option>
        ),
      )(data.listings)}
    </select>
  </p>
);

/** The range-scoped stats table: a heading naming the scope ("All listings" or
 *  one listing) above a key/value figure table. */
const LedgerStats = ({ data }: { data: LedgerPageData }): SafeHtml => (
  <>
    <h2>{data.statsHeading}</h2>
    <div class="table-scroll">
      <table class="listing-details-table">
        <tbody>
          <Raw html={renderDetailRows(data.stats)} />
        </tbody>
      </table>
    </div>
  </>
);

/**
 * The operator ledger page: range-scoped stats, a from/to date-range filter and
 * a by-listing select, then the visible transfer list (newest first, cash legs
 * hidden). `truncated` surfaces a "showing recent" note when older transfers
 * were dropped, like the global log.
 */
export const adminLedgerPage = (
  data: LedgerPageData,
  session: AdminSession,
): string =>
  String(
    <Layout title={t("admin.ledger.heading")}>
      <AdminNav active="/admin/ledger" session={session} />
      <p class="actions">
        <GuideLink href="/admin/guide#ledger">
          {t("admin.ledger.guide")}
        </GuideLink>
      </p>
      <LedgerStats data={data} />
      <div class="ledger-date-range">
        {map(
          (side: RangeSide): SafeHtml => <RangeField data={data} side={side} />,
        )(RANGE_SIDES)}
      </div>
      <ListingFilter data={data} />
      <LedgerTable names={data.names} transfers={data.transfers} />
      {data.truncated && <p>{t("admin.ledger.recent")}</p>}
    </Layout>,
  );

/**
 * One account's statement page: the account heading + balance and its full
 * running-balance statement. The nav already links back to the ledger, so no
 * separate back link is shown.
 */
export const adminAccountStatementPage = (
  account: AccountRef,
  lines: StatementLine[],
  names: LedgerNames,
  session: AdminSession,
): string =>
  String(
    <Layout title={t("admin.ledger.statement_heading")}>
      <AdminNav active="/admin/ledger" session={session} />
      <AccountStatementSection account={account} lines={lines} names={names} />
    </Layout>,
  );
