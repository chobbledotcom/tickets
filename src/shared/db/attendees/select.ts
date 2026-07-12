/**
 * Field-selection interface for reading attendee booking rows.
 *
 * Every attendee read used to share one of two fat SELECT projections
 * (`ATTENDEE_JOIN_SELECT` / `ATTENDEE_LEFT_JOIN_SELECT`) that always computed
 * the expensive ledger subqueries — `price_paid` alone is four correlated
 * subqueries per row — even when the caller displayed none of them. The admin
 * dashboard's recent-bookings table and the attendees browser, for example,
 * show only a booking's quantity, check-in state and refunded badge, yet paid
 * for `price_paid` and `remaining_balance` on every line.
 *
 * This module lets each caller declare exactly which projected fields it needs.
 * The builder always emits the cheap identity and per-listing columns and adds
 * an expensive field's subquery ONLY when it is asked for, so a table read that
 * wants none of the money fields runs none of their subqueries. Passing
 * {@link ATTENDEE_FIELDS} asks for every field and reproduces the old full
 * projection byte-for-byte (column order aside, which callers read by name).
 *
 * The three ledger-subquery fragments live here because this is where the
 * attendee projection is assembled; `queries.ts`, `tokens.ts` and `balance.ts`
 * import them for their own narrower projections.
 */

import type { InValue } from "@libsql/client";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  saleLegPredicate,
} from "#shared/accounting/projection-sql.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import type { Attendee } from "#shared/types.ts";

/**
 * Order-level refund status, projected from the transfers ledger rather than a
 * stored column: an attendee is refunded iff a `refund_cash` leg sourced from
 * their account exists (a refund reverses the booking's payment leg into a
 * `refund_cash` leg whose SOURCE is the attendee — both live and backfilled
 * historical refunds set this). Returns 0/1 aliased `refunded`, matching the
 * `number` shape the booking row type carries. A LEFT JOIN with no matching
 * `listing_attendees` row has `listingAttendee.attendee_id` NULL, so the EXISTS
 * is false (0).
 */
export const refundedFromLedger = (attendeeIdExpr: string): string =>
  `(SELECT EXISTS(SELECT 1 FROM transfers WHERE kind = '${KIND.refundCash}'` +
  ` AND ${accountPredicate("source", ATTENDEE, attendeeIdExpr)})) AS refunded`;

/**
 * Per-row amount paid, projected from the ledger instead of a stored column: the
 * gross `sale` leg this booking row recognised — `kind='sale'`, billed from the
 * attendee to the listing's revenue account, within the row's stored
 * `ledger_event_group` (so an attendee holding several orders for one listing
 * resolves to exactly this booking's leg). A site has one currency, so amounts
 * sum directly. Equals the dropped `price_paid` column for a fully-paid booking
 * (every production booking) and stays put after a refund (the reversal is a
 * separate `refund_*` leg). 0 when the row has no sale leg — a free or
 * provider-less-owed booking, or an unmatched LEFT JOIN row (NULL ids/group
 * match nothing).
 *
 * A booking's `sale` leg is posted once per listing, but a child that folds
 * under several parents — or folds AND keeps a standalone remainder — turns one
 * order into several `listing_attendees` rows sharing that single `(attendee,
 * listing, event_group)` leg. Crediting the whole leg to each row would
 * double-count the child on any summed readback, so the leg is split across
 * those rows in QUANTITY proportion, deterministically by row id: each row takes
 * `floor(total * qtyThroughThisRow / totalQty) − floor(total * qtyBeforeThisRow
 * / totalQty)`. Those shares telescope to the full leg with no penny lost, and
 * collapse to the whole leg for the ordinary one-row-per-listing case.
 * `rowIdExpr` is the row's own `id`; all four expressions MUST be qualified
 * (they seed correlated subqueries whose inner `sibling` alias would otherwise
 * shadow a bare column).
 *
 * The same split covers a listing booked through two order paths (a package
 * member row beside its standalone row). When those paths priced differently,
 * the quantity split AVERAGES the rows — the leg carries no per-path key to do
 * better with (see the per-path TODO entry). Sums over the order stay exact.
 */
export const pricePaidFromLedger = (
  attendeeIdExpr: string,
  listingIdExpr: string,
  eventGroupExpr: string,
  rowIdExpr: string,
): string => {
  const saleTotal = `(SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE ${saleLegPredicate(
    attendeeIdExpr,
    listingIdExpr,
    eventGroupExpr,
  )})`;
  const siblingQty = (idBound: string): string =>
    "(SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling" +
    ` WHERE sibling.attendee_id = ${attendeeIdExpr}` +
    ` AND sibling.listing_id = ${listingIdExpr}` +
    ` AND sibling.ledger_event_group = ${eventGroupExpr}${idBound})`;
  const through = siblingQty(` AND sibling.id <= ${rowIdExpr}`);
  const before = siblingQty(` AND sibling.id < ${rowIdExpr}`);
  // NULLIF guards the divide when no sibling has quantity (a lone no-quantity
  // sentinel, or an unmatched LEFT JOIN row); COALESCE then floors the NULL that
  // divide yields back to 0 so `price_paid` is always a number.
  const totalQty = `NULLIF(${siblingQty("")}, 0)`;
  return (
    `COALESCE(CAST(${saleTotal} * ${through} / ${totalQty} AS INTEGER)` +
    ` - CAST(${saleTotal} * ${before} / ${totalQty} AS INTEGER), 0) AS price_paid`
  );
};

/**
 * An attendee's outstanding balance, projected from the ledger instead of a
 * stored column: the negated account balance — what they still owe is the money
 * they were billed (sale legs sourced from them) minus the cash received
 * (deposit and balance-payment legs into them), with a refund's reversal legs
 * netting back out. 0 for a fully-paid booking (every production attendee) and
 * for an attendee with no legs. `attendeeIdExpr` is the attendee id in the
 * surrounding query.
 */
export const remainingBalanceFromLedger = (attendeeIdExpr: string): string =>
  `${attendeeOwedSubquery(attendeeIdExpr)} AS remaining_balance`;

/** Whether the surrounding query joins `listing_attendees` with an INNER or a
 * LEFT join. Under a LEFT join the cheap per-listing columns are COALESCEd so an
 * attendee with no matching booking row still reads sensible zeros. Callers MUST
 * pass the mode that matches their own FROM clause. */
export type AttendeeJoin = "inner" | "left";

/**
 * The projected fields a caller can opt into on top of the always-present core.
 * The first three are correlated ledger subqueries (expensive — `price_paid` is
 * four subqueries); the last three are cheap per-listing columns that most
 * table reads don't need. Everything not listed here (identity columns plus
 * `listing_id`, `date`, `quantity`, `checked_in`) is always emitted.
 */
export type AttendeeField =
  | "remaining_balance"
  | "refunded"
  | "price_paid"
  | "end_date"
  | "attachment_downloads"
  | "package_group_id";

/** Every selectable field — pass this to reproduce the old full projection. */
export const ATTENDEE_FIELDS = [
  "remaining_balance",
  "refunded",
  "price_paid",
  "end_date",
  "attachment_downloads",
  "package_group_id",
] as const satisfies readonly AttendeeField[];

/**
 * A row shape for a chosen field set: the full {@link Attendee} minus every
 * opt-in field, plus back exactly the ones selected. `AttendeeRowFor<never>`
 * (an empty field set) is the leanest money-free row; `AttendeeRowFor<
 * AttendeeField>` is the full `Attendee`. As with the old projections these are
 * raw rows — PII columns are still encrypted; decrypt with `decryptAttendees`.
 */
export type AttendeeRowFor<F extends AttendeeField = never> = Omit<
  Attendee,
  AttendeeField
> &
  Pick<Attendee, F>;

/** A cheap per-listing integer column, COALESCEd to 0 under a LEFT join so an
 * unmatched row reads 0 rather than NULL. */
const listingIntColumn = (join: AttendeeJoin, name: string): string =>
  join === "left"
    ? `COALESCE(listingAttendee.${name}, 0) as ${name}`
    : `listingAttendee.${name}`;

/** Identity columns plus the cheap per-listing columns every caller reads. */
const coreColumns = (join: AttendeeJoin): string =>
  [
    "attendee.id",
    "attendee.created",
    "attendee.kind",
    "attendee.ticket_token_index",
    "attendee.pii_blob",
    "attendee.status_id",
    "attendee.split_logistics_agents",
    listingIntColumn(join, "listing_id"),
    "SUBSTR(listingAttendee.start_at, 1, 10) as date",
    listingIntColumn(join, "quantity"),
    listingIntColumn(join, "checked_in"),
  ].join(", ");

/** Exhaustive map from each opt-in field to the SQL fragment that projects it.
 * A new field is a compile error here until it declares its fragment. */
const FIELD_SQL: Record<AttendeeField, (join: AttendeeJoin) => string> = {
  attachment_downloads: (join) =>
    listingIntColumn(join, "attachment_downloads"),
  end_date: () => "SUBSTR(listingAttendee.end_at, 1, 10) as end_date",
  package_group_id: (join) => listingIntColumn(join, "package_group_id"),
  price_paid: () =>
    pricePaidFromLedger(
      "listingAttendee.attendee_id",
      "listingAttendee.listing_id",
      "listingAttendee.ledger_event_group",
      "listingAttendee.id",
    ),
  refunded: () => refundedFromLedger("listingAttendee.attendee_id"),
  remaining_balance: () => remainingBalanceFromLedger("attendee.id"),
};

/**
 * The SELECT column list for an attendee read: the core columns plus one
 * fragment per requested field. Use this directly when the caller runs the
 * query itself (e.g. inside a `queryBatch`); otherwise reach for
 * {@link selectAttendees} / {@link selectAttendeeOrNull}.
 */
export const attendeeColumns = (
  join: AttendeeJoin,
  fields: readonly AttendeeField[],
): string =>
  [coreColumns(join), ...fields.map((field) => FIELD_SQL[field](join))].join(
    ", ",
  );

/** What every attendee read shares beyond its column list: the join mode, the
 * requested fields, and the `FROM … WHERE … ORDER …` tail plus its bound args.
 * `from` MUST join `listing_attendees AS listingAttendee` with the `join` mode
 * given, and reference `attendees AS attendee`. */
type AttendeeQuery<F extends AttendeeField> = {
  join: AttendeeJoin;
  fields: readonly F[];
  from: string;
  args?: InValue[];
};

const attendeeSql = <F extends AttendeeField>({
  join,
  fields,
  from,
}: AttendeeQuery<F>): string =>
  `SELECT ${attendeeColumns(join, fields)} ${from}`;

/**
 * Run an attendee read, returning one raw row per (attendee, booking line) typed
 * to exactly the requested fields. PII stays encrypted — decrypt before display.
 */
export const selectAttendees = <F extends AttendeeField>(
  query: AttendeeQuery<F>,
): Promise<AttendeeRowFor<F>[]> =>
  queryAll<AttendeeRowFor<F>>(attendeeSql(query), query.args);

/** Single-row attendee read (returns null when nothing matches). */
export const selectAttendeeOrNull = <F extends AttendeeField>(
  query: AttendeeQuery<F>,
): Promise<AttendeeRowFor<F> | null> =>
  queryOne<AttendeeRowFor<F>>(attendeeSql(query), query.args);
