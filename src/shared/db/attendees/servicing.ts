import { costAccount, WORLD } from "#shared/accounting/accounts.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { postTransfers, postTransfersTx } from "#shared/accounting/store.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type {
  AttendeeInput,
  CreateAttendeeResult,
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import {
  applyAttendeeAtomicEdit,
  type ExistingLine,
  loadExistingLines,
} from "#shared/db/attendees/atomic-update.ts";
import { dateToStartEnd } from "#shared/db/attendees/capacity.ts";
import {
  createAttendeeAtomicImpl as createAttendeeAtomic,
  ensureAllBookings,
} from "#shared/db/attendees/create.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  buildPiiBlob,
  decryptAttendeeFields,
  encryptPiiBlob,
} from "#shared/db/attendees/pii.ts";
import {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
} from "#shared/db/attendees/queries.ts";
import { queryAll, queryOne, withTransaction } from "#shared/db/client.ts";
import {
  type AttendeeAnswerSet,
  getAttendeeAnswersBatch,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import { type Attendee, normalizeDurationDays } from "#shared/types.ts";

export type ServicingQuestionAnswer = {
  questionId: number;
  answerId: number;
};

export type ServicingEventInput = {
  name: string;
  bookings: ListingBooking[];
  allowOverbook?: boolean;
  kind?: typeof SERVICING_KIND;
  questionAnswers?: ServicingQuestionAnswer[] | AttendeeAnswerSet;
};

export type ServicingEvent = {
  id: number;
  kind: typeof SERVICING_KIND;
  name: string;
  ticketToken: string;
  bookings: ListingBooking[];
};

/** One booking line of a service event (a `listing_attendees` slot the event
 *  holds). The listing *name* is resolved at render time against the cached
 *  listings, so the reader carries only the id. */
export type ServicingBookingSummary = {
  listingId: number;
  quantity: number;
};

/**
 * A service event summarised for the `/admin/servicing` list and the dashboard's
 * upcoming-events block: one per attendee (service event), with its booked
 * listing lines collected into `bookings` and a total quantity. Previously the
 * reader returned one row per `listing_attendees` booking line, so a
 * multi-listing hold appeared multiple times in the list and on the dashboard;
 * grouping by attendee gives one summary per event.
 */
export type ServicingEventSummary = {
  bookings: ServicingBookingSummary[];
  /** Earliest booking date (rows are read date-then-id ordered). */
  date: string | null;
  id: number;
  name: string;
  totalQuantity: number;
};

type ServicingRow = Attendee & { kind: string };

const NAME_REQUIRED = "name is required";
const INVALID_BOOKINGS = "servicing event must hold at least one capacity slot";

const hasNonPositiveQuantity = (booking: ListingBooking): boolean =>
  (booking.quantity ?? 1) <= 0;

const validatedServicingName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(NAME_REQUIRED);
  return trimmed;
};

const requireServicingBookings = (
  bookings: ListingBooking[],
  positiveQuantities: boolean,
): void => {
  if (bookings.length === 0) {
    throw new Error(INVALID_BOOKINGS);
  }
  if (positiveQuantities && bookings.some(hasNonPositiveQuantity)) {
    throw new Error(INVALID_BOOKINGS);
  }
};

const servicingInputAsserter =
  (positiveQuantities: boolean) =>
  (input: ServicingEventInput): string => {
    const name = validatedServicingName(input.name);
    requireServicingBookings(input.bookings, positiveQuantities);
    return name;
  };

const assertServicingInput = servicingInputAsserter(true);
const assertServicingEditInput = servicingInputAsserter(false);

const ensureServicingCreateBookings = async (
  result: CreateAttendeeResult,
  expectedCount: number,
): Promise<Extract<CreateAttendeeResult, { success: true }>> => {
  const check = await ensureAllBookings(result, expectedCount, "admin");
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return result as Extract<CreateAttendeeResult, { success: true }>;
};

const normalizedCreateInput = (
  input: ServicingEventInput,
  name: string,
): AttendeeInput => ({
  address: "",
  allowOverbook: input.allowOverbook,
  bookings: input.bookings,
  email: "",
  kind: SERVICING_KIND,
  name,
  paymentId: "",
  phone: "",
  remainingBalance: 0,
  special_instructions: "",
  statusId: null,
});

const answerSet = (
  answers: ServicingEventInput["questionAnswers"],
): AttendeeAnswerSet => {
  if (!answers) return { answerIds: [] };
  return Array.isArray(answers)
    ? { answerIds: answers.map((answer) => answer.answerId) }
    : answers;
};

const saveServicingAnswers = (
  attendeeId: number,
  answers: ServicingEventInput["questionAnswers"],
): Promise<void> =>
  saveAttendeeAnswers(new Map([[attendeeId, answerSet(answers)]]));

const durationDaysFromRow = (row: ListingAttendeeRow): number | undefined => {
  if (!row.start_at || !row.end_at) return undefined;
  const ms = new Date(row.end_at).getTime() - new Date(row.start_at).getTime();
  return normalizeDurationDays(Math.round(ms / 86_400_000));
};

const bookingFromRow = (row: ListingAttendeeRow): ListingBooking => {
  const date = row.start_at ? row.start_at.slice(0, 10) : null;
  const booking: ListingBooking = {
    date,
    listingId: row.listing_id,
    quantity: row.quantity,
  };
  const durationDays = durationDaysFromRow(row);
  if (date && durationDays !== undefined) booking.durationDays = durationDays;
  return booking;
};

const rowsToServicingEvent = async (
  rows: ServicingRow[],
): Promise<ServicingEvent> => {
  const attendee = await decryptAttendeeFields(rows[0]!, await requestKey());
  return {
    bookings: rows
      .filter((row) => row.listing_id > 0)
      .map((row) =>
        bookingFromRow({
          attachment_downloads: row.attachment_downloads,
          checked_in: Number(row.checked_in),
          end_at: row.end_date ? `${row.end_date}T00:00:00.000Z` : null,
          ledger_event_group: "",
          listing_id: row.listing_id,
          price_paid: Number(row.price_paid),
          quantity: row.quantity,
          refunded: Number(row.refunded),
          start_at: row.date ? `${row.date}T00:00:00Z` : null,
        }),
      ),
    id: attendee.id,
    kind: SERVICING_KIND,
    name: attendee.name,
    ticketToken: attendee.ticket_token,
  };
};

const requestKey = async (): Promise<CryptoKey> => {
  const { requireRequestPrivateKey } = await import(
    "#shared/session-private-key.ts"
  );
  return requireRequestPrivateKey();
};

export const getServicingEvent = async (
  id: number,
): Promise<ServicingEvent | null> => {
  const rows = await queryAll<ServicingRow>(
    `SELECT ${ATTENDEE_JOIN_SELECT}, a.kind
       FROM attendees a
       JOIN listing_attendees ea ON ea.attendee_id = a.id
      WHERE a.id = ? AND a.kind = ?
      ORDER BY ea.start_at, ea.listing_id`,
    [id, SERVICING_KIND],
  );
  if (rows.length > 0) return rowsToServicingEvent(rows);
  const orphan = await queryOne<ServicingRow>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}, a.kind
       FROM attendees a
       LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
      WHERE a.id = ? AND a.kind = ?`,
    [id, SERVICING_KIND],
  );
  return orphan ? rowsToServicingEvent([orphan]) : null;
};

export const createServicingEvent = async (
  input: ServicingEventInput,
): Promise<ServicingEvent> => {
  const name = assertServicingInput(input);
  const createResult = await ensureServicingCreateBookings(
    await createAttendeeAtomic(normalizedCreateInput(input, name)),
    input.bookings.length,
  );
  const id = createResult.attendees[0]!.id;
  // The attendee + bookings are committed by the atomic create; the remaining
  // side effects (answers, activity log) are a separate batch. Nested batches
  // aren't safe on the edge runtime, so a single outer transaction can't hold
  // them together — instead compensate: if a side effect fails, delete the
  // attendee so no half-saved service event (bookings without answers) remains.
  try {
    await saveServicingAnswers(id, input.questionAnswers);
    await logActivity(
      `Service event '${name}' created`,
      input.bookings[0]!.listingId,
      id,
    );
  } catch (error) {
    await deleteAttendee(id);
    throw error;
  }
  return (await getServicingEvent(id))!;
};

const servicingEventRowsToSummaries = async (
  rows: ServicingRow[],
  privateKey: CryptoKey,
): Promise<ServicingEventSummary[]> => {
  // Group booking lines by their parent service event (attendee id), so a
  // multi-listing hold renders as ONE summary (its listings collected inside)
  // instead of one row per booking line. Rows are ordered by date then attendee
  // id, so the first row of each group is that event's earliest booking line,
  // keeping the summaries in upcoming order.
  const byAttendee = new Map<number, ServicingRow[]>();
  for (const row of rows) {
    const group = byAttendee.get(row.id) ?? [];
    group.push(row);
    byAttendee.set(row.id, group);
  }
  return Promise.all(
    [...byAttendee.values()].map(async (group) => {
      const attendee = await decryptAttendeeFields(group[0]!, privateKey);
      const bookings: ServicingBookingSummary[] = group.map((row) => ({
        listingId: row.listing_id,
        quantity: row.quantity,
      }));
      return {
        bookings,
        date: group[0]!.date,
        id: attendee.id,
        name: attendee.name,
        totalQuantity: bookings.reduce(
          (sum, booking) => sum + booking.quantity,
          0,
        ),
      };
    }),
  );
};

const getServicingEventRows = (today?: string): Promise<ServicingRow[]> => {
  const upcomingClause =
    today === undefined
      ? ""
      : "AND (ea.start_at IS NULL OR DATE(ea.start_at) >= ?)";
  return queryAll<ServicingRow>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
       FROM attendees a
       JOIN listing_attendees ea ON ea.attendee_id = a.id
      WHERE a.kind = ?
        AND ea.quantity > 0
        ${upcomingClause}
      ORDER BY COALESCE(ea.start_at, a.created), a.id`,
    today === undefined ? [SERVICING_KIND] : [SERVICING_KIND, today],
  );
};

export const getAllServicingEvents = async (
  privateKey: CryptoKey,
): Promise<ServicingEventSummary[]> => {
  const rows = await getServicingEventRows();
  return servicingEventRowsToSummaries(rows, privateKey);
};

export const getUpcomingServicingEvents = async (
  privateKey: CryptoKey,
  today: string,
): Promise<ServicingEventSummary[]> => {
  const rows = await getServicingEventRows(today);
  return servicingEventRowsToSummaries(rows, privateKey);
};

const lineKeyForInput = (
  booking: ListingBooking,
  existingBySlot: Map<string, string>,
): { exists: boolean; key: string } => {
  const { startAt } = dateToStartEnd(
    booking.date ?? null,
    booking.durationDays ?? 1,
  );
  const key = existingBySlot.get(`${booking.listingId}|${startAt ?? ""}`) ?? "";
  return { exists: key !== "", key };
};

const desiredLines = (
  input: ServicingEventInput,
  existing: Array<{ key: string; booking: ListingAttendeeRow }>,
): DesiredListingLine[] => {
  const existingBySlot = new Map(
    existing.map(({ key, booking }) => [
      `${booking.listing_id}|${booking.start_at ?? ""}`,
      key,
    ]),
  );
  return input.bookings.map((booking) => {
    const date = booking.date ?? null;
    const durationDays = normalizeDurationDays(booking.durationDays ?? 1);
    return {
      ...lineKeyForInput(booking, existingBySlot),
      date,
      durationDays,
      listingId: booking.listingId,
      quantity: booking.quantity ?? 1,
    };
  });
};

/** Rebuild the desired-line set from an attendee's current booking rows. Used to
 *  restore the prior state when a post-edit side effect fails — every line
 *  carries its existing key + slot so {@link applyAttendeeAtomicEdit} treats
 *  them as a preserve-style re-apply. */
const desiredLinesFromExisting = (
  existing: ExistingLine[],
): DesiredListingLine[] =>
  existing.map(({ key, booking }) => {
    let date: string | null = null;
    if (booking.start_at) date = booking.start_at.slice(0, 10);
    return {
      date,
      durationDays: durationDaysFromRow(booking) ?? 1,
      exists: true,
      key,
      listingId: booking.listing_id,
      quantity: booking.quantity,
    };
  });

/** Restore a service event's name, bookings, and answers to their pre-edit
 *  state after a post-edit side effect fails. `existingBefore` is the pre-edit
 *  booking rows; `answersBefore` is the pre-edit answer set. Overbooks
 *  unconditionally: the prior bookings fit before the edit, so restoring them
 *  must not itself strand on the capacity guard. */
const restoreServicingState = async (
  id: number,
  before: ServicingEvent,
  existingBefore: ExistingLine[],
  answersBefore: AttendeeAnswerSet,
): Promise<void> => {
  const restoredPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      address: "",
      email: "",
      name: before.name,
      payment_id: "",
      phone: "",
      special_instructions: "",
      ticket_token: before.ticketToken,
    }),
    settings.publicKey,
  );
  await applyAttendeeAtomicEdit(
    id,
    restoredPiiBlob,
    desiredLinesFromExisting(existingBefore),
    true,
  );
  await saveAttendeeAnswers(new Map([[id, answersBefore]]));
};

export const updateServicingEvent = async (
  id: number,
  input: ServicingEventInput,
): Promise<ServicingEvent> => {
  const name = assertServicingEditInput(input);
  const current = await getServicingEvent(id);
  if (!current) throw new Error("servicing event not found");
  const [existingBefore, answersBeforeMap] = await Promise.all([
    loadExistingLines(id),
    getAttendeeAnswersBatch([id], { texts: false }),
  ]);
  const answersBefore: AttendeeAnswerSet = {
    answerIds: answersBeforeMap.get(id) ?? [],
  };
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      address: "",
      email: "",
      name,
      payment_id: "",
      phone: "",
      special_instructions: "",
      ticket_token: current.ticketToken,
    }),
    settings.publicKey,
  );
  const editResult = await applyAttendeeAtomicEdit(
    id,
    encryptedPiiBlob,
    desiredLines(input, existingBefore),
    input.allowOverbook ?? false,
  );
  if (!editResult.success) throw new Error(editResult.reason);
  // The booking + name edit is committed by the atomic edit; the answer save is
  // a separate batch. If it fails, compensate by restoring the pre-edit state
  // (name, bookings, and answers) so the edit doesn't land half-applied.
  try {
    await saveServicingAnswers(id, input.questionAnswers);
  } catch (error) {
    await restoreServicingState(id, current, existingBefore, answersBefore);
    throw error;
  }
  return (await getServicingEvent(id))!;
};

export const deleteServicingEvent = async (id: number): Promise<void> => {
  if (!(await getServicingEvent(id))) {
    throw new Error("servicing event not found");
  }
  await deleteAttendee(id);
};

export const buildDuplicateServicingInput = (
  event: ServicingEvent,
): ServicingEventInput => ({
  bookings: event.bookings,
  kind: SERVICING_KIND,
  name: event.name,
});

export const duplicateServicingEvent = async (
  id: number,
): Promise<ServicingEvent> => {
  const original = await getServicingEvent(id);
  if (!original) throw new Error("servicing event not found");
  return createServicingEvent(buildDuplicateServicingInput(original));
};

export type RecordServiceCostInput = {
  servicingId: number;
  listingId: number;
  amount: number;
  occurredAt: string;
  memo: string;
  reference?: string;
};

/** True when the servicing event holds `listingId` (has a `listing_attendees`
 *  booking for it). Backs the route's pre-post form-validation as well as
 *  {@link assertServicingHoldsListing}'s throw. */
export const servicingHoldsListing = async (
  servicingId: number,
  listingId: number,
): Promise<boolean> => {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one
       FROM attendees AS attendee
       JOIN listing_attendees AS booking ON booking.attendee_id = attendee.id
      WHERE attendee.id = ?
        AND attendee.kind = ?
        AND booking.listing_id = ?
      LIMIT 1`,
    [servicingId, SERVICING_KIND, listingId],
  );
  return row !== null;
};

const assertServicingHoldsListing = async (
  servicingId: number,
  listingId: number,
): Promise<void> => {
  if (!(await servicingHoldsListing(servicingId, listingId))) {
    throw new Error("service cost must target a held listing");
  }
};

const costReferenceParts = (input: RecordServiceCostInput) =>
  [
    "service_cost",
    input.reference ?? input.servicingId,
    input.listingId,
    input.occurredAt,
    input.amount,
  ] as const;

const serviceCostTransfer = async (
  input: RecordServiceCostInput,
): Promise<TransferInput> => ({
  amount: input.amount,
  destination: WORLD,
  eventGroup: await eventGroup([...costReferenceParts(input)]),
  kind: "service_cost",
  memo: await encrypt(input.memo),
  occurredAt: input.occurredAt,
  reference:
    input.reference ?? (await legReference([...costReferenceParts(input)])),
  source: costAccount(input.listingId),
});

export const recordServiceCost = async (
  input: RecordServiceCostInput,
): Promise<number> => {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error("service cost amount must be a positive integer");
  }
  await assertServicingHoldsListing(input.servicingId, input.listingId);
  const transfer = await serviceCostTransfer(input);
  const encryptedMemo = transfer.memo!;
  // Idempotent on the transfer reference: the cost form carries a per-render
  // idempotency key the route passes as `reference`, so a browser retry /
  // double-click of the same form re-posts the same reference. Short-circuit
  // and return the already-recorded cost id *before* re-posting — a fresh
  // per-request `occurredAt` would otherwise trip the ledger's replay-equality
  // guard ("stored leg differs in occurredAt") and surface a 500.
  const existing = await queryOne<{ id: number }>(
    "SELECT id FROM transfers WHERE reference = ?",
    [transfer.reference],
  );
  if (existing) return existing.id;
  // Post the cost leg AND its first-class `service_costs` record in one
  // transaction, so the per-event cost list can never miss a posted cost (a
  // leg without a service_costs row would count in costOf but be unlistable).
  // Use INSERT … SELECT to derive transfer_id by reference lookup rather than
  // last_insert_rowid(): if a concurrent request committed the same transfer
  // first, postTransfersTx returns early (no INSERT), leaving last_insert_rowid
  // stale; the SELECT always resolves to the correct row regardless.
  await withTransaction(async (tx) => {
    await postTransfersTx(tx, [transfer]);
    await tx.execute({
      args: [
        input.servicingId,
        input.listingId,
        input.occurredAt,
        encryptedMemo,
        nowIso(),
        transfer.reference,
      ],
      sql:
        "INSERT OR IGNORE INTO service_costs " +
        "(servicing_attendee_id, listing_id, transfer_id, occurred_at, memo, created) " +
        "SELECT ?, ?, id, ?, ?, ? FROM transfers WHERE reference = ?",
    });
  });
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM transfers WHERE reference = ?",
    [transfer.reference],
  );
  return row!.id;
};

type CostRow = {
  id: number;
  source_type: string;
  source_id: string;
  dest_type: string;
  dest_id: string;
  amount: number;
  memo?: string;
};

const COST_ROW_SELECT =
  "id, source_type, source_id, dest_type, dest_id, amount";

const getCostRow = async (costId: number): Promise<CostRow | null> =>
  queryOne<CostRow>(
    `SELECT ${COST_ROW_SELECT}
       FROM transfers
      WHERE id = ? AND kind = 'service_cost'`,
    [costId],
  );

const loadCostRow = async (costId: number): Promise<CostRow> => {
  const row = await getCostRow(costId);
  if (!row) throw new Error("service cost not found");
  return row;
};

/** The listing id a `service_cost` transfer attributes its cost to: the cost
 *  account is `source` for a `cost:L → world` leg and `destination` for a
 *  `world → cost:L` reduction leg, so the listing id is on whichever side is
 *  the `cost` account. */
const costListingId = (row: CostRow): number =>
  Number(row.source_type === "cost" ? row.source_id : row.dest_id);

/** True when `costId` is a `service_cost` transfer recorded against
 *  `servicingId`. Queries the `service_costs` join table directly so a cost
 *  belonging to a *different* service event on the same listing cannot slip
 *  through the listing-membership check. */
export const costBelongsToServicing = async (
  costId: number,
  servicingId: number,
): Promise<boolean> => {
  const row = await queryOne<{ n: number }>(
    "SELECT 1 AS n FROM service_costs WHERE transfer_id = ? AND servicing_attendee_id = ?",
    [costId, servicingId],
  );
  return row !== null;
};

export const editServiceCost = async (
  costId: number,
  update: { amount: number },
  servicingId?: number,
): Promise<void> => {
  // Mirror recordServiceCost's guard: the target amount must be a positive
  // safe integer of minor units, so an edit can't post a negative or fractional
  // cost adjustment against the listing's profit. The route validates first and
  // returns a form error; this is the defence-in-depth data-layer check.
  if (!Number.isSafeInteger(update.amount) || update.amount <= 0) {
    throw new Error("service cost amount must be a positive integer");
  }
  const original = await loadCostRow(costId);
  const listingId = costListingId(original);
  if (servicingId !== undefined) {
    await assertServicingHoldsListing(servicingId, listingId);
  }
  // Compute the current effective amount: original + all prior adjustments.
  // A delta against the original would double-count prior edits — each edit
  // posts the full distance from original, so a second edit would reuse the
  // same base and overshoot.
  const adjMemo = `${ADJ_MEMO_PREFIX}${costId}`;
  const adjLegs = await queryAll<{
    source_type: string;
    amount: number;
    memo: string;
  }>(
    "SELECT source_type, amount, memo FROM transfers WHERE kind = 'service_cost' AND " +
      "((source_type = 'cost' AND source_id = ?) OR (dest_type = 'cost' AND dest_id = ?))",
    [String(listingId), String(listingId)],
  );
  // Pre-decrypt all memos (async), then accumulate synchronously so V8 block
  // coverage can instrument both branches of the signed-amount ternary.
  const decryptedMemos = await Promise.all(
    adjLegs.map((leg) => decrypt(leg.memo)),
  );
  const signedAdjTotal = adjLegs.reduce(
    (sum, leg, i) =>
      decryptedMemos[i] !== adjMemo
        ? sum
        : sum + (leg.source_type === "cost" ? leg.amount : -leg.amount),
    0,
  );
  const currentAmount = original.amount + signedAdjTotal;
  const delta = update.amount - currentAmount;
  if (delta === 0) return;
  const amount = Math.abs(delta);
  const cost = costAccount(listingId);
  await postTransfers([
    {
      amount,
      destination: delta > 0 ? WORLD : cost,
      eventGroup: await eventGroup([
        "service_cost_edit",
        costId,
        currentAmount,
        update.amount,
      ]),
      kind: "service_cost",
      memo: await encrypt(`${ADJ_MEMO_PREFIX}${costId}`),
      occurredAt: nowIso(),
      reference: await legReference([
        "service_cost_edit",
        costId,
        currentAmount,
        update.amount,
      ]),
      source: delta > 0 ? cost : WORLD,
    },
  ]);
};

/** A derived, operator-facing service-cost record for `/admin/servicing/:id`'s
 *  cost list: the original cost leg's id (the edit route target), its current
 *  amount (original ± adjustment legs), the service date, the listing it was
 *  attributed to, and the decrypted operator memo. */
export type ServicingCostRecord = {
  amount: number;
  date: string;
  id: number;
  listingId: number;
  memo: string;
};

/** Machine-generated memo written into adjustment legs so they can be
 *  attributed back to their original cost. The `\x00` prefix makes it
 *  impossible to collide with a free-text operator memo (form input cannot
 *  contain NUL bytes). */
const ADJ_MEMO_PREFIX = "\x00svc_adj:";
const EDIT_COST_MEMO = new RegExp(`^${ADJ_MEMO_PREFIX}(\\d+)$`);

/**
 * The service-cost records recorded against one service event, each with its
 * CURRENT amount derived from the append-only ledger: the original `cost:L`
 * leg (linked via `service_costs.transfer_id`) plus every `service_cost`
 * adjustment leg whose memo names that original (`edit service cost {id}`).
 * Members are stored PII-free / owner-key-encrypted, so the memo decrypts with
 * the global key here for display.
 */
export const getServicingCosts = async (
  servicingId: number,
): Promise<ServicingCostRecord[]> => {
  const records = await queryAll<{
    transfer_id: number;
    listing_id: number;
    occurred_at: string;
    memo: string;
  }>(
    "SELECT transfer_id, listing_id, occurred_at, memo FROM service_costs WHERE servicing_attendee_id = ? ORDER BY occurred_at, transfer_id",
    [servicingId],
  );
  if (records.length === 0) return [];
  const listingIds = [...new Set(records.map((r) => r.listing_id))];
  const placeholders = listingIds.map(() => "?").join(", ");
  const legs = await queryAll<CostRow>(
    `SELECT id, source_type, source_id, dest_type, dest_id, amount, memo FROM transfers WHERE kind = 'service_cost' AND ((source_type = 'cost' AND source_id IN (${placeholders})) OR (dest_type = 'cost' AND dest_id IN (${placeholders}))) ORDER BY id`,
    [...listingIds.map(String), ...listingIds.map(String)],
  );
  const decoded = await Promise.all(
    legs.map(async (leg) => ({
      amount: leg.amount,
      id: leg.id,
      isIncrease: leg.source_type === "cost",
      memoText: await decrypt(leg.memo!),
    })),
  );
  const adjustmentsByOriginal = new Map<number, number>();
  for (const leg of decoded) {
    const match = leg.memoText.match(EDIT_COST_MEMO);
    if (!match) continue;
    const originalId = Number(match[1]);
    let signedDelta: number;
    if (leg.isIncrease) {
      signedDelta = leg.amount;
    } else {
      signedDelta = -leg.amount;
    }
    adjustmentsByOriginal.set(
      originalId,
      (adjustmentsByOriginal.get(originalId) ?? 0) + signedDelta,
    );
  }
  const results: ServicingCostRecord[] = [];
  await Promise.all(
    records.map(async (r) => {
      const original = decoded.find((leg) => leg.id === r.transfer_id)!;
      results.push({
        amount:
          original.amount + (adjustmentsByOriginal.get(r.transfer_id) ?? 0),
        date: r.occurred_at,
        id: r.transfer_id,
        listingId: r.listing_id,
        memo: await decrypt(r.memo!),
      });
    }),
  );
  return results;
};
