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

import { t } from "#i18n";
import {
  isRowAccountType,
  isSingletonAccountType,
  type RowAccountType,
  type SingletonAccountType,
} from "#shared/accounting/accounts.ts";
import {
  isManualLedgerTransfer,
  manualLedgerEntryOptionsFor,
} from "#shared/accounting/manual-entries.ts";
import { formatCurrency, formatSignedCurrency } from "#shared/currency.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  LedgerDateRange,
  type LedgerFilterData,
  LedgerViewToggle,
  ScopeFilter,
} from "#templates/admin/ledger/filter.tsx";
import {
  humanAmount,
  humanDescription,
  transferEventLabel,
} from "#templates/admin/ledger/formatting.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { ReorderTable } from "#templates/components/reorder-table.tsx";
import { colClass } from "#templates/components/table-columns.ts";

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

/** The resolved presentation of one account leg: the text to show, and its
 * filtered ledger href (absent for singletons and deleted entities). */
type AccountLabel = { text: string; href?: string };

/** One row-backed account type's resolver config: which names map to read, the
 * ledger path, and the i18n key for the "#<id>" deleted-entity
 * fallback. Currying over this keeps the three row-backed types identical. */
type RowAccountKind = {
  names: (refs: LedgerNames) => Map<number, string>;
  href: (id: number) => string;
  fallbackKey: string;
};

/** Row-backed account resolvers keyed by ledger account type — exhaustive over
 * {@link RowAccountType}, so a new row-backed type cannot render without
 * deciding its label source and link target here. */
const ROW_ACCOUNT_KINDS: Record<RowAccountType, RowAccountKind> = {
  attendee: {
    fallbackKey: "admin.ledger.fallback.attendee",
    href: (id) => `/admin/ledger/attendee/${id}`,
    names: (refs) => refs.attendees,
  },
  cost: {
    fallbackKey: "admin.ledger.fallback.revenue",
    href: listingLedgerHref,
    names: (refs) => refs.listings,
  },
  modifier: {
    fallbackKey: "admin.ledger.fallback.modifier",
    href: (id) => `/admin/ledger/modifier/${id}`,
    names: (refs) => refs.modifiers,
  },
  revenue: {
    fallbackKey: "admin.ledger.fallback.revenue",
    href: listingLedgerHref,
    names: (refs) => refs.listings,
  },
};

/** The bounded id→name lookup for one row-backed account type — the single
 * accessor the label resolver and the route layer's existence checks share. */
export const ledgerNamesForAccountType = (
  type: RowAccountType,
  names: LedgerNames,
): Map<number, string> => ROW_ACCOUNT_KINDS[type].names(names);

/** Singleton accounts get a friendly, link-free name from i18n, matched on the
 * account type alone (`writeoff:*` is one logical account regardless of id).
 * Exhaustive over {@link SingletonAccountType}. */
const SINGLETON_LABEL_KEYS: Record<SingletonAccountType, string> = {
  external: "admin.ledger.account.external",
  fee_income: "admin.ledger.account.fee_income",
  writeoff: "admin.ledger.account.writeoff",
};

/**
 * Resolve an account reference to its display text and optional ledger link.
 * Singletons (`external:world`, `fee_income:booking`, `writeoff:*`) get a
 * friendly i18n name and never link. Row-backed accounts link to their entity by
 * name; when the id is absent from `names` (a deleted entity that kept its ledger
 * rows) the leg degrades to plain "<Entity> #<id>" with no link.
 */
const resolveAccountLabel = (
  account: AccountRef,
  names: LedgerNames,
): AccountLabel => {
  if (isSingletonAccountType(account.type)) {
    return { text: t(SINGLETON_LABEL_KEYS[account.type]) };
  }
  if (!isRowAccountType(account.type)) {
    throw new Error(`Unknown money account type: ${account.type}`);
  }
  const kind = ROW_ACCOUNT_KINDS[account.type];
  const id = Number(account.id);
  const name = ledgerNamesForAccountType(account.type, names).get(id);
  return name === undefined
    ? { text: t(kind.fallbackKey, { id }) }
    : { href: kind.href(id), text: name };
};

/** The plain display text for an account (no link), for headings/captions. */
export const accountLabelText = (
  account: AccountRef,
  names: LedgerNames,
): string => resolveAccountLabel(account, names).text;

/** One resolved account leg as cell content: a link when the entity exists,
 * plain (escaped) text otherwise. Interpolated (`{accountCell(...)}`) rather than
 * a `<Component/>` so the plain-text case can stay un-wrapped, like the activity
 * log's bare link cells. */
export const accountCellFor =
  (names: LedgerNames) =>
  (account: AccountRef): JSX.Element | string => {
    const { text, href } = resolveAccountLabel(account, names);
    return href === undefined ? text : <a href={href}>{text}</a>;
  };

/** A path-safe return URL is threaded into edit/add forms so mutations can send
 * the operator back to the exact statement or filtered ledger they came from. */
const withReturnUrl = (href: string, returnUrl: string): string =>
  `${href}?return_url=${encodeURIComponent(returnUrl)}`;

export const ledgerEntryEditHref = (
  transferId: number,
  returnUrl: string,
): string =>
  withReturnUrl(`/admin/ledger/entries/${transferId}/edit`, returnUrl);

export const ledgerEntryAddHref = (
  account: AccountRef,
  returnUrl: string,
): string =>
  withReturnUrl(`/admin/ledger/${account.type}/${account.id}/add`, returnUrl);

export const canAddLedgerEntry = (
  account: AccountRef,
  names: LedgerNames,
): boolean =>
  !isReadOnly() &&
  manualLedgerEntryOptionsFor(account).length > 0 &&
  resolveAccountLabel(account, names).href !== undefined;

export const amountCell = (
  transfer: Transfer,
  label: string,
  returnUrl?: string,
): JSX.Element | string =>
  !returnUrl || isReadOnly() || !isManualLedgerTransfer(transfer) ? (
    label
  ) : (
    <a href={ledgerEntryEditHref(transfer.id, returnUrl)}>{label}</a>
  );

/** One column of a ledger-style table: its header key, how a row renders into
 * its cell, and an optional alignment class applied to both. */
export type LedgerColumn<Row> = {
  headerKey: string;
  cell: (row: Row) => JSX.Element | string;
  class?: string;
};

/** The right-aligned money column shape shared by every ledger table. */
export const amountColumn = <Row,>(
  headerKey: string,
  cell: (row: Row) => JSX.Element | string,
): LedgerColumn<Row> => ({ cell, class: colClass("amount"), headerKey });

/**
 * Render a scrollable table from a column spec — the one place a ledger
 * table's header row, body rows, and empty-state row are assembled. The
 * empty-state colspan derives from the spec's length, so it can never drift
 * from the column count the way a hand-written `colspan="4"` could.
 */
export const LedgerColumnsTable = <Row,>({
  columns,
  rows,
}: {
  columns: LedgerColumn<Row>[];
  rows: Row[];
}): JSX.Element => (
  <ReorderTable
    columns={columns.map((column) => (
      <th class={column.class}>{t(column.headerKey)}</th>
    ))}
    orderLabel=""
    reorder={false}
  >
    {rows.length > 0 ? (
      rows.map((row) => (
        <tr>
          {columns.map((column) => (
            <td class={column.class}>{column.cell(row)}</td>
          ))}
        </tr>
      ))
    ) : (
      <tr>
        <td colspan={columns.length}>{t("admin.ledger.empty")}</td>
      </tr>
    )}
  </ReorderTable>
);

/** The shared leading column: a transfer's business time. */
export const timeColumn = <Row,>(
  occurredAt: (row: Row) => string,
): LedgerColumn<Row> => ({
  cell: (row) => formatDatetimeShort(occurredAt(row)),
  headerKey: "admin.ledger.col.time",
});

/**
 * The historical transfer list: every leg as From → To with its kind, time, and
 * amount. Scrollable on narrow screens like the other admin tables.
 */
type TransferTableData = {
  transfers: Transfer[];
  names: LedgerNames;
  returnUrl?: string;
};

type TransferColumns = (
  accountCell: (account: AccountRef) => JSX.Element | string,
  returnUrl: string | undefined,
) => LedgerColumn<Transfer>[];

const makeTransferTable =
  (columns: TransferColumns) =>
  ({ transfers, names, returnUrl }: TransferTableData): JSX.Element =>
    LedgerColumnsTable({
      columns: columns(accountCellFor(names), returnUrl),
      rows: transfers,
    });

const transferColumns = (
  activity: LedgerColumn<Transfer>[],
  amountLabel: (transfer: Transfer) => string,
  returnUrl: string | undefined,
): LedgerColumn<Transfer>[] => [
  timeColumn((transfer: Transfer) => transfer.occurredAt),
  ...activity,
  amountColumn<Transfer>("admin.ledger.col.amount", (transfer) =>
    amountCell(transfer, amountLabel(transfer), returnUrl),
  ),
];

const LedgerTable = makeTransferTable((accountCell, returnUrl) =>
  transferColumns(
    [
      { cell: transferEventLabel, headerKey: "admin.ledger.col.event" },
      {
        cell: (transfer) => (
          <>
            {accountCell(transfer.source)} &rarr;{" "}
            {accountCell(transfer.destination)}
          </>
        ),
        headerKey: "admin.ledger.col.from_to",
      },
    ],
    (transfer) => formatCurrency(transfer.amount),
    returnUrl,
  ),
);

const HumanLedgerTable = makeTransferTable((accountCell, returnUrl) =>
  transferColumns(
    [
      {
        cell: (transfer) => humanDescription(transfer, accountCell),
        headerKey: "admin.ledger.col.activity",
      },
    ],
    (transfer) => formatSignedCurrency(humanAmount(transfer)),
    returnUrl,
  ),
);

/** Everything the (render-only) ledger page needs: the visible transfers and
 *  their name lookup, the range-scoped stats, the current filter state, and the
 *  data the two date pickers + listing select render from. */
export type LedgerPageData = LedgerFilterData & {
  transfers: Transfer[];
  names: LedgerNames;
  truncated: boolean;
  stats: DetailRow[];
  /** Scope heading above the stats table — the listing name when scoped to one,
   *  null for the whole-business view (which needs no heading). */
  statsHeading: string | null;
  returnUrl: string;
};

export const adminLedgerShell = (
  titleKey: string,
  session: AdminSession,
  children: Child,
): string =>
  String(
    <AdminPage active="/admin/ledger" session={session} title={t(titleKey)}>
      {children}
    </AdminPage>,
  );

/** The range-scoped stats table: a key/value figure table, headed by the
 *  listing name when scoped to one listing (the whole-business view needs no
 *  heading — the page title already says "Ledger"). */
const LedgerStats = ({ data }: { data: LedgerPageData }): JSX.Element => (
  <>
    {data.statsHeading && <h2>{data.statsHeading}</h2>}
    <DetailTable rows={data.stats} />
  </>
);

/**
 * The operator ledger page: range-scoped stats, dates, listing/group scope, then
 * the visible transfer list (newest first, cash legs
 * hidden). `truncated` surfaces a "showing recent" note when older transfers
 * were dropped, like the global log.
 */
export const adminLedgerPage = (
  data: LedgerPageData,
  session: AdminSession,
): string =>
  adminLedgerShell(
    "admin.ledger.heading",
    session,
    <>
      <LedgerStats data={data} />
      <PageBlock>
        <LedgerDateRange data={data} />
        <ScopeFilter data={data} />
        <LedgerViewToggle data={data} />
        {data.filters.view === "dual" ? (
          <LedgerTable
            names={data.names}
            returnUrl={data.returnUrl}
            transfers={data.transfers}
          />
        ) : (
          <HumanLedgerTable
            names={data.names}
            returnUrl={data.returnUrl}
            transfers={data.transfers}
          />
        )}
        {data.truncated && <p>{t("admin.ledger.recent")}</p>}
      </PageBlock>
      <GuideFooter href="/admin/guide#ledger">
        {t("admin.ledger.guide")}
      </GuideFooter>
    </>,
  );
