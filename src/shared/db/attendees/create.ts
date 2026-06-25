/**
 * Atomic attendee creation across one or more listing bookings.
 */

import type { InValue } from "@libsql/client";
import { bookingLegBatchInsert } from "#shared/accounting/rows.ts";
import { assertPostable } from "#shared/accounting/store.ts";
import { addDays } from "#shared/dates.ts";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#shared/db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#shared/db/attendees/booking-slot.ts";
import { buildCapacityCheckedInsert } from "#shared/db/attendees/capacity.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import {
  contactFields,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import {
  executeBatchWithResults,
  inPlaceholders,
  insert,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  type BookingSource,
  hashEmail,
  hashPhone,
  recordBooking,
  recordVisit,
  unrecordBooking,
  unrecordVisit,
} from "#shared/db/contact-preferences.ts";
import {
  allModifiersInStockCondition,
  anyModifierSoldOut,
  type ModifierUsage,
  usageInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatement } from "#shared/db/processed-payments.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { bestEffort } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { type Attendee, normalizeDurationDays } from "#shared/types.ts";

/**
 * Enforce all-or-nothing semantics on a (greedy) create result.
 *
 * `createAttendeeAtomic` fulfils bookings greedily: it returns success as
 * long as at least one booking was created. Callers that need every
 * requested line to succeed pass the expected count here; if the result is
 * short, the partially-created attendee is rolled back and a failure reason
 * is returned. Shared by the public checkout flow, the webhook flow, and the
 * admin manual-add form so the "no half-saved attendee" rule lives in one
 * place.
 */
export const ensureAllBookings = async (
  result: CreateAttendeeResult,
  expectedCount: number,
  source: BookingSource,
): Promise<
  { ok: true } | { ok: false; reason: "capacity_exceeded" | "encryption_error" }
> => {
  if (result.success && result.attendees.length >= expectedCount) {
    return { ok: true };
  }
  if (result.success && result.attendees.length > 0) {
    const attendee = result.attendees[0]!;
    await deleteAttendee(attendee.id);
    // The greedy create already recorded a visit + booking for this contact;
    // undo it now that the order is being rolled back. Best-effort: callers
    // such as the paid webhook refund after this returns, so a contact-stats
    // write failure must not escape here and skip the refund.
    await bestEffort("reverseOrderActivity on partial rollback", () =>
      reverseOrderActivity(attendee.email, attendee.phone, source),
    );
  }
  return {
    ok: false,
    reason: result.success ? "capacity_exceeded" : result.reason,
  };
};

/** Order-level fields shared by every booking in one atomic create. */
type AttendeeOrderFields = {
  statusId: number | null;
  remainingBalance: number;
};

/** Build an INSERT statement for the attendees table from encrypted fields.
 *  The outstanding balance is no longer a stored column — it projects from the
 *  transfers ledger as −balanceOf(attendee) — so the insert never writes it; a
 *  booking that owes money records the owed amount with its sale leg instead. */
export const buildAttendeeInsert = (
  enc: EncryptedAttendeeData,
  order: AttendeeOrderFields,
) =>
  insert("attendees", {
    created: enc.created,
    pii_blob: enc.encryptedPiiBlob,
    status_id: order.statusId,
    ticket_token_index: enc.ticketTokenIndex,
  });

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  listing_id: input.listingId,
  ...contactFields(input),
  attachment_downloads: 0,
  checked_in: false,
  created: input.created,
  date: input.date,
  // Exclusive end (start + duration), matching SUBSTR(end_at) on the read path.
  // Null for date-less bookings, where no range is stored.
  end_date: input.date
    ? addDays(input.date, normalizeDurationDays(input.durationDays ?? 1))
    : null,
  payment_id: input.paymentId,
  pii_blob: "",
  price_paid: String(input.pricePaid),
  quantity: input.quantity,
  refunded: false,
  remaining_balance: input.remainingBalance,
  split_logistics_agents: false,
  status_id: input.statusId,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
});

/** Collect the contact-identity hashes for an order (email and/or phone). */
const orderContactHashes = (
  email: unknown,
  phone: unknown,
): Promise<string[]> => {
  const hashes: Promise<string>[] = [];
  if (typeof email === "string" && email.trim()) {
    hashes.push(hashEmail(email));
  }
  if (typeof phone === "string" && phone.trim()) {
    hashes.push(hashPhone(phone));
  }
  return Promise.all(hashes);
};

/** Apply a visit + source-tagged booking change to every contact on an order.
 * Curried over the per-hash primitives so recording and its exact reverse share
 * one implementation. */
const applyOrderActivity =
  (
    visitFn: (hash: string) => Promise<void>,
    bookingFn: (hash: string, source: BookingSource) => Promise<void>,
  ) =>
  async (email: unknown, phone: unknown, source: BookingSource) => {
    for (const hash of await orderContactHashes(email, phone)) {
      await visitFn(hash);
      await bookingFn(hash, source);
    }
  };

const recordOrderActivity = applyOrderActivity(recordVisit, recordBooking);

/** Reverse {@link recordOrderActivity} when an order is rolled back after the
 * greedy create already recorded it (partial booking, post-payment refund). */
export const reverseOrderActivity = applyOrderActivity(
  unrecordVisit,
  unrecordBooking,
);

type Statement = { sql: string; args: InValue[] };

/** Per-booking success flags and the new attendee row id (always set in
 *  practice — an INSERT returns its rowid). */
type WriteOutcome = { flags: boolean[]; insertId: number | bigint | undefined };

/** Posts the ledger legs for a created attendee inside the same transaction, so
 *  a booking and its legs commit or roll back together. The id is only known
 *  after the attendee insert, so it is passed in. */
export type LedgerPoster = (tx: TxScope, attendeeId: number) => Promise<void>;

/** Thrown to roll the transaction back when no booking could be created (the
 *  ledger-posting path has no final cleanup DELETE; it just rolls back). */
class NoBookingsCreated extends Error {}

/** Remove the just-inserted attendee when none of its capacity-checked booking
 *  inserts landed a row (the batch path's all-failed cleanup). */
const cleanupDeleteStatement = (ticketTokenIndex: InValue): Statement => ({
  args: [ticketTokenIndex, ticketTokenIndex],
  sql: `DELETE FROM attendees WHERE id = (
          SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM listing_attendees WHERE attendee_id = (
            SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
          )
        )`,
});

/**
 * Run one ACID batch whose statements are, in order: the attendee INSERT, the
 * `bookingCount` capacity-checked booking INSERTs, then any number of follow-up
 * statements (cleanup, and — for the ledger batch — modifier/leg/finalize). The
 * per-booking landed flags come from results 1..bookingCount; null is returned
 * when none landed (the attendee was cleaned up). The single place the attendee/
 * booking batch result decoding lives, shared by the plain and ledger batches. */
const runAttendeeBatch = async (
  statements: Statement[],
  bookingCount: number,
): Promise<WriteOutcome | null> => {
  const batchResults = await executeBatchWithResults(statements);
  const flags = Array.from(
    { length: bookingCount },
    (_, i) => batchResults[i + 1]!.rowsAffected > 0,
  );
  return flags.some(Boolean)
    ? { flags, insertId: batchResults[0]!.lastInsertRowid }
    : null;
};

/** The fast path: one ACID batch (attendee, bookings, all-failed cleanup).
 *  Returns null when no booking landed (the attendee was cleaned up). */
const writeAsBatch = (
  attendeeInsert: Statement,
  bookingStatements: Statement[],
  ticketTokenIndex: InValue,
): Promise<WriteOutcome | null> =>
  runAttendeeBatch(
    [
      attendeeInsert,
      ...bookingStatements,
      cleanupDeleteStatement(ticketTokenIndex),
    ],
    bookingStatements.length,
  );

/** The ledger path: an interactive transaction so the ledger legs commit
 *  atomically with the attendee and bookings. This path is all-or-nothing —
 *  the legs describe the whole order, so if any booking fails its capacity check
 *  the transaction rolls back and null is returned (the caller refunds), rather
 *  than posting legs for listings that were not booked. */
const writeWithLedger = (
  attendeeInsert: Statement,
  bookingStatements: Statement[],
  postLedger: LedgerPoster,
): Promise<WriteOutcome | null> =>
  withTransaction<WriteOutcome>(async (tx) => {
    const insertId = (await tx.execute(attendeeInsert)).lastInsertRowid;
    const flags: boolean[] = [];
    for (const statement of bookingStatements) {
      flags.push((await tx.execute(statement)).rowsAffected > 0);
    }
    if (!flags.every(Boolean)) throw new NoBookingsCreated();
    await postLedger(tx, Number(insertId));
    return { flags, insertId };
  }).catch((error) => {
    if (error instanceof NoBookingsCreated) return null;
    throw error;
  });

/**
 * The attendee-id subquery used everywhere a freshly-inserted attendee's id must
 * be referenced later in the SAME batch (its booking links, its ledger legs, the
 * finalize). last_insert_rowid() can't be used — it shifts after each INSERT in
 * the batch — and ticket_token_index is unique, so MAX(id) for that token is
 * this attendee. The single `?` binds the token index. */
export const ATTENDEE_BY_TOKEN_SQL =
  "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";

/** SQL gate that holds only once every one of the order's `expectedCount`
 *  bookings has landed, so the ledger legs / finalize apply on full success and
 *  are skipped on a partial booking (cleaned up afterwards). */
const allBookingsLandedGuard = (
  ticketTokenIndex: InValue,
  expectedCount: number,
): Statement => ({
  args: [ticketTokenIndex, expectedCount],
  sql: `(SELECT COUNT(*) FROM listing_attendees WHERE attendee_id = ${ATTENDEE_BY_TOKEN_SQL}) = ?`,
});

/** What a prepared write needs in hand before touching the database. */
type PreparedWrite = {
  enc: EncryptedAttendeeData;
  attendeeInsert: Statement;
  bookingStatements: Statement[];
};

const andConditions = (conditions: Statement[]): Statement => ({
  args: conditions.flatMap((condition) => condition.args),
  sql: conditions.map((condition) => `(${condition.sql})`).join(" AND "),
});

const noExistingLedgerCondition = (legs: TransferInput[]): Statement => {
  if (legs.length === 0) return { args: [], sql: "1 = 1" };
  const eventGroup = legs[0]!.eventGroup;
  const references = legs.map((leg) => leg.reference);
  return {
    args: [eventGroup, ...references],
    sql: `NOT EXISTS (SELECT 1 FROM transfers WHERE event_group = ?)
          AND NOT EXISTS (SELECT 1 FROM transfers WHERE reference IN (${inPlaceholders(
            references,
          )}))`,
  };
};

/**
 * Validate the order and encrypt the attendee, returning the attendee INSERT and
 * the capacity-checked booking INSERTs — or a failure reason. `extraCondition` is
 * AND-ed into every booking's WHERE (the batch booking path folds in the
 * all-modifiers-in-stock guard so a sold-out add-on stops the booking landing).
 * Shared by every create strategy so validation/encryption lives in one place. */
const prepareAttendeeWrite = async (
  input: AttendeeInput,
  extraCondition?: Statement,
): Promise<
  | { ok: true; prepared: PreparedWrite }
  | { ok: false; failure: Extract<CreateAttendeeResult, { success: false }> }
> => {
  const {
    bookings,
    paymentId = "",
    statusId = null,
    remainingBalance = 0,
    allowOverbook = false,
  } = input;
  // Reject empty orders, negative quantities (a negative row skews capacity
  // sums), and duplicate (listing_id, date) slots (the unique index would drop
  // one insert and half-fulfil the cart).
  if (
    bookings.length === 0 ||
    bookings.some((b) => (b.quantity ?? 1) < 0) ||
    hasDuplicateBookingSlot(bookings)
  ) {
    return {
      failure: { reason: "capacity_exceeded", success: false },
      ok: false,
    };
  }

  // Use first booking's pricePaid for encryption (PII blob is shared)
  const enc = await encryptAttendeeFields({
    address: input.address ?? "",
    email: input.email,
    name: input.name,
    paymentId,
    phone: input.phone ?? "",
    pricePaid: bookings[0]!.pricePaid ?? 0,
    special_instructions: input.special_instructions ?? "",
  });
  if (!enc) {
    return {
      failure: { reason: "encryption_error", success: false },
      ok: false,
    };
  }

  const bookingStatements = bookings.map((booking) => {
    const insert = buildCapacityCheckedInsert(
      booking,
      ATTENDEE_BY_TOKEN_SQL,
      undefined,
      allowOverbook,
    );
    // Splice ticketTokenIndex after listingId to bind the ? in the subquery,
    // then AND in the extra condition (its args trail the capacity args).
    const combined: InValue[] = [
      insert.args[0]!,
      enc.ticketTokenIndex,
      ...insert.args.slice(1),
      ...(extraCondition && !allowOverbook ? extraCondition.args : []),
    ];
    const sql =
      extraCondition && !allowOverbook
        ? `${insert.sql} AND (${extraCondition.sql})`
        : insert.sql;
    return { args: combined, sql };
  });

  return {
    ok: true,
    prepared: {
      attendeeInsert: buildAttendeeInsert(enc, { remainingBalance, statusId }),
      bookingStatements,
      enc,
    },
  };
};

/**
 * Turn a successful write into the per-booking Attendee results and record the
 * order's contact activity (one visit + booking per identity). A no-quantity-only
 * order is not a real visit/booking, so the activity is gated on a real line.
 * Shared by every create strategy. */
const finishAttendeeWrite = async (
  written: WriteOutcome,
  input: AttendeeInput,
  enc: EncryptedAttendeeData,
): Promise<CreateAttendeeResult> => {
  const { bookings, source = "public" } = input;
  const contactInfo = {
    address: input.address ?? "",
    email: input.email,
    name: input.name,
    phone: input.phone ?? "",
    special_instructions: input.special_instructions ?? "",
  };
  const successfulBookings: Attendee[] = bookings.flatMap((booking, i) =>
    written.flags[i]
      ? [
          buildAttendeeResult({
            insertId: written.insertId,
            listingId: booking.listingId,
            ...contactInfo,
            created: enc.created,
            date: booking.date ?? null,
            durationDays: booking.durationDays,
            paymentId: input.paymentId ?? "",
            pricePaid: booking.pricePaid ?? 0,
            quantity: booking.quantity ?? 1,
            remainingBalance: input.remainingBalance ?? 0,
            statusId: input.statusId ?? null,
            ticketToken: enc.ticketToken,
            ticketTokenIndex: enc.ticketTokenIndex,
          }),
        ]
      : [],
  );
  if (successfulBookings.some((b) => b.quantity > 0)) {
    await recordOrderActivity(contactInfo.email, contactInfo.phone, source);
  }
  return { attendees: successfulBookings, success: true };
};

/** What one create strategy supplies to {@link createWith}: the extra booking
 *  WHERE condition (the batch path's modifier-stock guard), the write strategy
 *  (interactive transaction or batch), and what "no booking landed" means for
 *  that path (plain capacity failure, or — for the batch — possibly sold-out). */
type CreateStrategy<R extends CreateAttendeeResult | "sold-out"> = {
  condition?: Statement;
  write: (prepared: PreparedWrite) => Promise<WriteOutcome | null>;
  noBooking: () => R | Promise<R>;
};

/**
 * The one create pipeline, curried over the per-strategy parts: prepare
 * (validate + encrypt + build the attendee/booking inserts) → run the write →
 * on success finish (build results + record contact activity); a prepare failure
 * or a no-booking write returns the strategy's failure. Both public creators are
 * thin specialisations, so the prepare/finish glue lives in exactly one place. */
const createWith =
  <R extends CreateAttendeeResult | "sold-out">(strategy: CreateStrategy<R>) =>
  async (input: AttendeeInput): Promise<CreateAttendeeResult | R> => {
    const prep = await prepareAttendeeWrite(input, strategy.condition);
    if (!prep.ok) return prep.failure;
    const written = await strategy.write(prep.prepared);
    return written
      ? finishAttendeeWrite(written, input, prep.prepared.enc)
      : strategy.noBooking();
  };

/**
 * Atomically create an attendee linked to one or more listings.
 *   1. INSERT attendee (unconditional)
 *   2..N+1. For each booking: INSERT listing_attendees with capacity check
 *   3. Clean up / roll back the attendee if ALL capacity checks failed
 * Returns one Attendee per successful booking. When `postLedger` is given, the
 * write runs in one interactive transaction and the ledger legs are posted in
 * it, so the booking and its legs are all-or-nothing.
 */
export const createAttendeeAtomicImpl = (
  input: AttendeeInput,
  postLedger?: LedgerPoster,
): Promise<CreateAttendeeResult> =>
  createWith<CreateAttendeeResult>({
    noBooking: () => ({ reason: "capacity_exceeded", success: false }),
    // Ledger path: an interactive transaction so the legs commit with the
    // attendee/bookings (all-or-nothing). Plain path: one batch with an
    // all-failed cleanup DELETE.
    write: ({ attendeeInsert, bookingStatements, enc }) =>
      postLedger
        ? writeWithLedger(attendeeInsert, bookingStatements, postLedger)
        : writeAsBatch(attendeeInsert, bookingStatements, enc.ticketTokenIndex),
  })(input);

/**
 * The ledger work to commit atomically with a booking, as DATA rather than a
 * transaction callback — so the whole booking can be one libsql batch instead of
 * a chatty interactive transaction. `legs` are the booking's ledger legs (built
 * by mapBooking with a placeholder attendee id; their references/event group are
 * attendee-id-independent, and the real id is spliced in by subquery at write
 * time). `finalizeSessionId`, when set, finalizes that payment session in the
 * same batch as the attendee INSERT. */
export type BookingBatchPlan = {
  usages: ModifierUsage[];
  legs: TransferInput[];
  finalizeSessionId?: string;
};

/**
 * Assemble and run the single batch for a booking that posts ledger legs:
 * attendee INSERT, capacity- AND modifier-stock-guarded booking INSERTs, then —
 * each gated on every booking having landed — the modifier-usage consumes, the
 * `INSERT OR IGNORE` legs, the ledger_event_group stamp, the optional finalize,
 * and finally the all-failed cleanup DELETE. One round-trip, one transaction:
 * commits the whole booking or, when a booking can't land, leaves nothing the
 * caller's all-or-nothing check won't clean up. Returns the flags + new id, or
 * null when no booking landed. */
const writeAsLedgerBatch = async (
  prepared: PreparedWrite,
  plan: BookingBatchPlan,
  expectedCount: number,
): Promise<WriteOutcome | null> => {
  const { attendeeInsert, bookingStatements, enc } = prepared;
  const tokenIndex = enc.ticketTokenIndex;
  const guard = allBookingsLandedGuard(tokenIndex, expectedCount);

  assertPostable(plan.legs);
  const recordedAt = nowIso();
  const usageStatements = plan.usages.map((usage) =>
    usageInsert(usage, ATTENDEE_BY_TOKEN_SQL, [tokenIndex], guard),
  );
  const legStatements = plan.legs.map((leg) =>
    bookingLegBatchInsert(leg, recordedAt, ATTENDEE_BY_TOKEN_SQL, tokenIndex, {
      args: guard.args,
      sql: guard.sql,
    }),
  );
  // Stamp the order's event group onto the booking rows so each row's amount-paid
  // projection resolves exactly this booking's legs — only once all bookings landed.
  const eventGroupUpdate: Statement[] =
    plan.legs.length > 0
      ? [
          {
            args: [plan.legs[0]!.eventGroup, tokenIndex, ...guard.args],
            sql: `UPDATE listing_attendees SET ledger_event_group = ?
                  WHERE attendee_id = ${ATTENDEE_BY_TOKEN_SQL} AND ${guard.sql}`,
          },
        ]
      : [];
  const finalizeStatements: Statement[] = plan.finalizeSessionId
    ? [
        batchFinalizeStatement(
          plan.finalizeSessionId,
          ATTENDEE_BY_TOKEN_SQL,
          tokenIndex,
          guard,
        ),
      ]
    : [];

  return runAttendeeBatch(
    [
      attendeeInsert,
      ...bookingStatements,
      ...usageStatements,
      ...legStatements,
      ...eventGroupUpdate,
      ...finalizeStatements,
      cleanupDeleteStatement(tokenIndex),
    ],
    bookingStatements.length,
  );
};

/**
 * Create a booking and post its ledger legs as ONE libsql batch — the fast path
 * that replaces the interactive transaction for the paid/free checkout. The
 * booking, its modifier-stock consumes, its sale/payment legs, the booking-row
 * event-group stamp, and (when finalizing a paid session) the session finalize
 * all commit or roll back together, in a single round-trip that never holds an
 * interactive write transaction open against the primary.
 *
 * Returns `"sold-out"` when a chosen modifier had no stock left (the
 * stock-guarded booking insert lands no row), so the caller keeps a placeholder
 * and refunds; otherwise the usual create result (a partial cart is the caller's
 * all-or-nothing concern, via ensureAllBookings). */
export const createBookingAtomic = (
  input: AttendeeInput,
  plan: BookingBatchPlan,
): Promise<CreateAttendeeResult | "sold-out"> =>
  createWith<CreateAttendeeResult | "sold-out">({
    condition: andConditions([
      allModifiersInStockCondition(plan.usages),
      noExistingLedgerCondition(plan.legs),
    ]),
    // No booking landed: tell capacity-full from a sold-out modifier so the
    // caller shows the right reason (and keeps the right placeholder).
    noBooking: async () =>
      (await anyModifierSoldOut(plan.usages))
        ? "sold-out"
        : { reason: "capacity_exceeded", success: false },
    // expectedCount === one booking statement per booking, so it equals the
    // prepared booking-statement count.
    write: (prepared) =>
      writeAsLedgerBatch(prepared, plan, prepared.bookingStatements.length),
  })(input);
