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
import type { ManualLedgerEntryOption } from "#shared/accounting/manual-entries.ts";
import {
  isManualLedgerTransfer,
  manualLedgerEntryOptionsFor,
} from "#shared/accounting/manual-entries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
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
import {
  ActionButton,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
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

const canAddLedgerEntry = (account: AccountRef, names: LedgerNames): boolean =>
  !isReadOnly() &&
  manualLedgerEntryOptionsFor(account).length > 0 &&
  resolveAccountLabel(account, names).href !== undefined;

const amountCell = (
  transfer: Transfer,
  label: string,
  returnUrl?: string,
): JSX.Element | string =>
  !returnUrl || isReadOnly() || !isManualLedgerTransfer(transfer) ? (
    label
  ) : (
    <a href={ledgerEntryEditHref(transfer.id, returnUrl)}>{label}</a>
  );

/** A transfer's kind, or an em dash when it carries none. */
const kindLabel = (transfer: Transfer): string => transfer.kind ?? "—";

/** One row of the historical transfer list. */
const LedgerRow = ({
  transfer,
  names,
  returnUrl,
}: {
  transfer: Transfer;
  names: LedgerNames;
  returnUrl?: string;
}): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(transfer.occurredAt)}</td>
      <td>{kindLabel(transfer)}</td>
      <td>
        {accountCell(transfer.source, names)} &rarr;{" "}
        {accountCell(transfer.destination, names)}
      </td>
      <td class={colClass("amount")}>
        {amountCell(transfer, formatCurrency(transfer.amount), returnUrl)}
      </td>
    </tr>,
  );

/** The historical transfer rows, or a single empty-state row spanning the table
 * when there are none — mirroring the activity log's empty row. */
const ledgerRows = (
  transfers: Transfer[],
  names: LedgerNames,
  returnUrl?: string,
): string =>
  transfers.length > 0
    ? pipe(
        map((transfer: Transfer) => LedgerRow({ names, returnUrl, transfer })),
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
  returnUrl,
}: {
  transfers: Transfer[];
  names: LedgerNames;
  returnUrl?: string;
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
        <Raw html={ledgerRows(transfers, names, returnUrl)} />
      </tbody>
    </table>
  </div>
);

const humanAccount = (transfer: Transfer, type: string): AccountRef | null => {
  if (transfer.source.type === type) return transfer.source;
  if (transfer.destination.type === type) return transfer.destination;
  return null;
};

const sentenceWithAccount = (
  key: string,
  account: AccountRef | null,
  names: LedgerNames,
): JSX.Element =>
  account ? (
    <>
      {t(key)} {accountCell(account, names)}
    </>
  ) : (
    <span>{t(key)}</span>
  );

const fallbackHumanDescription = (
  transfer: Transfer,
  names: LedgerNames,
): JSX.Element => (
  <>
    {t("admin.ledger.human.transfer_from")}{" "}
    {accountCell(transfer.source, names)} {t("admin.ledger.human.transfer_to")}{" "}
    {accountCell(transfer.destination, names)}
  </>
);

const saleDescription = (
  transfer: Transfer,
  names: LedgerNames,
): JSX.Element => (
  <>
    {accountCell(transfer.source, names)} {t("admin.ledger.human.booked")}{" "}
    {accountCell(transfer.destination, names)}
  </>
);

const adjustmentDescription = (
  transfer: Transfer,
  names: LedgerNames,
): JSX.Element => {
  if (
    transfer.source.type === "attendee" &&
    transfer.destination.type === "writeoff"
  ) {
    return sentenceWithAccount(
      "admin.ledger.human.manual_attendee_charge",
      transfer.source,
      names,
    );
  }
  if (
    transfer.source.type === "writeoff" &&
    transfer.destination.type === "attendee"
  ) {
    return sentenceWithAccount(
      "admin.ledger.human.manual_attendee_writeoff",
      transfer.destination,
      names,
    );
  }
  if (transfer.source.type === "writeoff") {
    return sentenceWithAccount(
      "admin.ledger.human.adjustment_increase",
      transfer.destination,
      names,
    );
  }
  if (transfer.destination.type === "writeoff") {
    return sentenceWithAccount(
      "admin.ledger.human.adjustment_reduce",
      transfer.source,
      names,
    );
  }
  return fallbackHumanDescription(transfer, names);
};

const humanDescription = (
  transfer: Transfer,
  names: LedgerNames,
): JSX.Element => {
  switch (transfer.kind) {
    case "sale":
      return saleDescription(transfer, names);
    case "payment":
      return sentenceWithAccount(
        "admin.ledger.human.payment",
        humanAccount(transfer, "attendee"),
        names,
      );
    case "refund_cash":
      return sentenceWithAccount(
        "admin.ledger.human.refund_cash",
        humanAccount(transfer, "attendee"),
        names,
      );
    case "refund_sale":
      return sentenceWithAccount(
        "admin.ledger.human.refund_sale",
        humanAccount(transfer, "revenue"),
        names,
      );
    case "fee":
      return <>{t("admin.ledger.human.fee")}</>;
    case "refund_fee":
      return <>{t("admin.ledger.human.refund_fee")}</>;
    case "adjustment":
      return adjustmentDescription(transfer, names);
    case "manual_attendee_payment":
      return sentenceWithAccount(
        "admin.ledger.human.manual_attendee_payment",
        humanAccount(transfer, "attendee"),
        names,
      );
    case "manual_attendee_charge":
      return sentenceWithAccount(
        "admin.ledger.human.manual_attendee_charge",
        humanAccount(transfer, "attendee"),
        names,
      );
    case "manual_attendee_writeoff":
      return sentenceWithAccount(
        "admin.ledger.human.manual_attendee_writeoff",
        humanAccount(transfer, "attendee"),
        names,
      );
    case "manual_listing_income":
      return sentenceWithAccount(
        "admin.ledger.human.manual_listing_income",
        humanAccount(transfer, "revenue"),
        names,
      );
    case "manual_listing_cost":
      return sentenceWithAccount(
        "admin.ledger.human.manual_listing_cost",
        humanAccount(transfer, "revenue"),
        names,
      );
    case "manual_modifier_income":
      return sentenceWithAccount(
        "admin.ledger.human.manual_modifier_income",
        humanAccount(transfer, "modifier"),
        names,
      );
    case "manual_modifier_reduction":
      return sentenceWithAccount(
        "admin.ledger.human.manual_modifier_reduction",
        humanAccount(transfer, "modifier"),
        names,
      );
    default:
      return fallbackHumanDescription(transfer, names);
  }
};

const HumanLedgerRow = ({
  transfer,
  names,
  returnUrl,
}: {
  transfer: Transfer;
  names: LedgerNames;
  returnUrl?: string;
}): JSX.Element => (
  <tr>
    <td>{formatDatetimeShort(transfer.occurredAt)}</td>
    <td>{humanDescription(transfer, names)}</td>
    <td class={colClass("amount")}>
      {amountCell(transfer, formatCurrency(transfer.amount), returnUrl)}
    </td>
  </tr>
);

export const HumanLedgerTable = ({
  transfers,
  names,
  returnUrl,
}: {
  transfers: Transfer[];
  names: LedgerNames;
  returnUrl?: string;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>{t("admin.ledger.col.time")}</th>
          <th>{t("admin.ledger.col.activity")}</th>
          <th class={colClass("amount")}>{t("admin.ledger.col.amount")}</th>
        </tr>
      </thead>
      <tbody>
        {transfers.length > 0 ? (
          transfers.map((transfer) => (
            <HumanLedgerRow
              names={names}
              returnUrl={returnUrl}
              transfer={transfer}
            />
          ))
        ) : (
          <tr>
            <td colspan="3">{t("admin.ledger.empty")}</td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

/** The signed delta of a statement line, formatted with an explicit sign so a
 * credit and a debit of the same magnitude never read alike. */
const signedAmount = (signed: number): string =>
  `${signed < 0 ? "-" : "+"}${formatCurrency(Math.abs(signed))}`;

/**
 * Whether an account's statement figures should be shown with their sign
 * flipped. The ledger stores an attendee's account as a liability — a booking
 * debits it negative, a payment credits it back toward zero — which is correct
 * double-entry but reads backwards to a non-accountant: they expect a charge to
 * show as a positive amount owed and a payment to bring it down. So an attendee
 * statement negates its signed deltas and running balance; every other account
 * (revenue, modifier, the singletons) keeps its native ledger sign. */
const isReversedAccount = (account: AccountRef): boolean =>
  account.type === "attendee";

/** A statement figure (signed delta or running balance) as shown for an account,
 * flipping its sign for the {@link isReversedAccount reversed} attendee view. The
 * `value !== 0` guard keeps a zero figure from becoming negative zero, which
 * would render as a stray "-£0". */
const shownFigure = (value: number, account: AccountRef): number =>
  isReversedAccount(account) && value !== 0 ? -value : value;

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
  returnUrl,
}: {
  line: StatementLine;
  account: AccountRef;
  names: LedgerNames;
  returnUrl?: string;
}): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(line.transfer.occurredAt)}</td>
      <td>{kindLabel(line.transfer)}</td>
      <td>{accountCell(counterparty(line, account), names)}</td>
      <td class={colClass("amount")}>
        {amountCell(
          line.transfer,
          signedAmount(shownFigure(line.signed, account)),
          returnUrl,
        )}
      </td>
      <td class={colClass("amount")}>
        {formatCurrency(shownFigure(line.running, account))}
      </td>
    </tr>,
  );

/** The statement rows, or an empty-state row spanning the table when the account
 * has no history. */
const statementRows = (
  lines: StatementLine[],
  account: AccountRef,
  names: LedgerNames,
  returnUrl?: string,
): string =>
  lines.length > 0
    ? pipe(
        map((line: StatementLine) =>
          StatementRow({ account, line, names, returnUrl }),
        ),
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
  returnUrl,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
  returnUrl?: string;
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
        <Raw html={statementRows(lines, account, names, returnUrl)} />
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
      {t("admin.ledger.balance", {
        amount: formatCurrency(shownFigure(balance, account)),
      })}
    </p>
  );
};

export type AccountLedgerData = {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
};

const AccountStatementActions = ({
  account,
  names,
  fullLedgerHref,
  returnUrl,
}: {
  account: AccountRef;
  names: LedgerNames;
  fullLedgerHref?: string;
  returnUrl: string;
}): JSX.Element | null => {
  const showAdd = canAddLedgerEntry(account, names);
  if (!showAdd && !fullLedgerHref) return null;
  return (
    <p class="table-action-btns">
      {showAdd && (
        <ActionButton href={ledgerEntryAddHref(account, returnUrl)} icon="plus">
          {t("admin.ledger.add.link")}
        </ActionButton>
      )}
      {fullLedgerHref && (
        <ActionButton href={fullLedgerHref}>
          {t("attendee_detail.view_full_ledger")}
        </ActionButton>
      )}
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
  returnUrl,
  fullLedgerHref,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
  returnUrl: string;
  fullLedgerHref?: string;
}): JSX.Element => (
  <div class="table-controls">
    <AccountStatementHeading account={account} lines={lines} names={names} />
    <AccountStatementActions
      account={account}
      fullLedgerHref={fullLedgerHref}
      names={names}
      returnUrl={returnUrl}
    />
    <AccountStatementTable
      account={account}
      lines={lines}
      names={names}
      returnUrl={returnUrl}
    />
  </div>
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
  view: LedgerViewMode;
};

export type LedgerViewMode = "human" | "dual";

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
  returnUrl: string;
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
  if (merged.view === "dual") params.set("view", "dual");
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
  <p class="table-action-btns">
    {t("admin.ledger.filter.listing")}:
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

const LedgerViewToggle = ({ data }: { data: LedgerPageData }): SafeHtml => (
  <p class="table-action-btns">
    {data.filters.view === "human" ? (
      <>
        <strong>{t("admin.ledger.view.human")}</strong>
        <a href={ledgerHref(data.filters, { view: "dual" })}>
          {t("admin.ledger.view.dual")}
        </a>
      </>
    ) : (
      <>
        <a href={ledgerHref(data.filters, { view: "human" })}>
          {t("admin.ledger.view.human")}
        </a>
        <strong>{t("admin.ledger.view.dual")}</strong>
      </>
    )}
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
      <div class="table-controls">
        <div class="ledger-date-range">
          {map(
            (side: RangeSide): SafeHtml => (
              <RangeField data={data} side={side} />
            ),
          )(RANGE_SIDES)}
        </div>
        <ListingFilter data={data} />
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
      </div>
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
      <AccountStatementSection
        account={account}
        lines={lines}
        names={names}
        returnUrl={`/admin/ledger/${account.type}/${account.id}`}
      />
    </Layout>,
  );

export type LedgerEntryFormValues = {
  amount: string;
  occurredAt: string;
  entryType?: string;
};

export type LedgerEntryAddOption = ManualLedgerEntryOption & {
  label: string;
  hint: string;
};

const LedgerEntryFields = ({
  values,
}: {
  values: LedgerEntryFormValues;
}): JSX.Element => (
  <>
    <label>
      {t("admin.ledger.form.amount")}
      <input
        inputmode="decimal"
        min="0"
        name="amount"
        required
        step="0.01"
        type="number"
        value={values.amount}
      />
    </label>
    <label>
      {t("admin.ledger.form.occurred_at")}
      <input
        name="occurred_at"
        required
        type="datetime-local"
        value={values.occurredAt}
      />
    </label>
  </>
);

export const adminLedgerEntryAddPage = ({
  account,
  names,
  options,
  values,
  returnUrl,
  session,
  error,
}: {
  account: AccountRef;
  names: LedgerNames;
  options: LedgerEntryAddOption[];
  values: LedgerEntryFormValues;
  returnUrl: string;
  session: AdminSession;
  error?: string;
}): string =>
  String(
    <Layout title={t("admin.ledger.add.heading")}>
      <AdminNav active="/admin/ledger" session={session} />
      <CsrfForm action={`/admin/ledger/${account.type}/${account.id}/add`}>
        <h1>{t("admin.ledger.add.heading")}</h1>
        <Flash error={error} />
        <p>
          {t("admin.ledger.add.account")}{" "}
          <strong>{accountLabelText(account, names)}</strong>
        </p>
        <input name="return_url" type="hidden" value={returnUrl} />
        <label>
          {t("admin.ledger.add.type")}
          <select name="entry_type" required>
            {options.map((option) => (
              <option
                selected={values.entryType === option.type}
                value={option.type}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <ul>
          {options.map((option) => (
            <li>
              <strong>{option.label}:</strong> {option.hint}
            </li>
          ))}
        </ul>
        <LedgerEntryFields values={values} />
        <SubmitButton icon="plus">{t("admin.ledger.add.submit")}</SubmitButton>
        <p>
          <ActionButton href={returnUrl} variant="secondary">
            {t("common.cancel")}
          </ActionButton>
        </p>
      </CsrfForm>
    </Layout>,
  );

export const adminLedgerEntryEditPage = ({
  transfer,
  names,
  values,
  returnUrl,
  session,
  error,
}: {
  transfer: Transfer;
  names: LedgerNames;
  values: LedgerEntryFormValues;
  returnUrl: string;
  session: AdminSession;
  error?: string;
}): string =>
  String(
    <Layout title={t("admin.ledger.edit.heading")}>
      <AdminNav active="/admin/ledger" session={session} />
      <h1>{t("admin.ledger.edit.heading")}</h1>
      <Flash error={error} />
      <p>{humanDescription(transfer, names)}</p>
      <CsrfForm action={`/admin/ledger/entries/${transfer.id}/edit`}>
        <input name="return_url" type="hidden" value={returnUrl} />
        <LedgerEntryFields values={values} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      <ConfirmForm
        action={`/admin/ledger/entries/${transfer.id}/delete`}
        buttonText={t("admin.ledger.delete.submit")}
        label={t("admin.ledger.delete.label")}
        name={formatCurrency(transfer.amount)}
        returnUrl={returnUrl}
      >
        <h2>{t("admin.ledger.delete.heading")}</h2>
        <p>{t("admin.ledger.delete.warning")}</p>
        <p>
          {t("admin.ledger.delete.confirm_prompt", {
            amount: formatCurrency(transfer.amount),
          })}
        </p>
      </ConfirmForm>
      <p>
        <ActionButton href={returnUrl} variant="secondary">
          {t("common.cancel")}
        </ActionButton>
      </p>
    </Layout>,
  );
