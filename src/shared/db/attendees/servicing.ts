import { sumByKey, sumOf, unique } from "#fp";
import { costAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { postTransfers, postTransfersTx } from "#shared/accounting/store.ts";
import { capacityErrorFormatter } from "#shared/capacity-error.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
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
  ATTENDEE_FIELDS,
  attendeeColumns,
} from "#shared/db/attendees/select.ts";
import {
  inPlaceholders,
  queryAll,
  queryOne,
  withTransaction,
} from "#shared/db/client.ts";
import { getListingNamesByIds } from "#shared/db/listings.ts";
import {
  type AttendeeAnswersBatch,
  getAttendeeAnswersBatch,
} from "#shared/db/questions/attendee-answers/reads.ts";
import {
  type AttendeeAnswerSet,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers/save.ts";
import { settings } from "#shared/db/settings.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import { type Attendee, normalizeDurationDays } from "#shared/types.ts";

/** An answer chosen for a service event's custom question. Only the `answerId`
 *  is needed — `saveAttendeeAnswers` resolves each answer's question itself, so
 *  carrying a `questionId` here could only ever disagree with it. */
export type ServicingQuestionAnswer = {
  answerId: number;
};

export type ServicingEventInput = {
  name: string;
  bookings: ListingBooking[];
  allowOverbook?: boolean;
  questionAnswers?: ServicingQuestionAnswer[];
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

/** Admin-facing message for a servicing event that couldn't hold every
 *  requested capacity slot — names the SPECIFIC listing(s) that were sold
 *  out instead of surfacing the bare "capacity_exceeded"/"encryption_error"
 *  reason string. */
const formatServicingCapacityError = capacityErrorFormatter({
  fallback: "Failed to save the service event. Please try again.",
  generic: "Not enough spots available.",
  withName: (name) => `Not enough spots available for: ${name}`,
});

/** The comma-joined names of the given listing ids, dropping any id whose
 *  listing has since been deleted (a name lookup miss) rather than throwing. */
const joinedListingNames = async (ids: number[]): Promise<string> => {
  const names = await getListingNamesByIds(ids);
  return ids
    .map((id) => names.get(id))
    .filter((name): name is string => Boolean(name))
    .join(", ");
};

/** The requested listing ids among `bookings` that did NOT land a booking row
 *  in create `result` — a multiset diff by listing id, so a listing requested
 *  twice and fulfilled only once is still named. When NOTHING landed at all
 *  (the create's own failure shape, `result.success === false` — e.g. a
 *  single-listing hold that didn't fit), every requested listing is named:
 *  there's no partial attendee to diff against, and for a single booking that
 *  IS the specific listing that failed. */
const unfulfilledListingIds = (
  bookings: ListingBooking[],
  result: CreateAttendeeResult,
): number[] => {
  if (!result.success) return unique(bookings.map((b) => b.listingId));
  const remaining = new Map<number, number>();
  for (const attendee of result.attendees) {
    remaining.set(
      attendee.listing_id,
      (remaining.get(attendee.listing_id) ?? 0) + 1,
    );
  }
  const failed: number[] = [];
  for (const booking of bookings) {
    const have = remaining.get(booking.listingId) ?? 0;
    if (have > 0) remaining.set(booking.listingId, have - 1);
    else failed.push(booking.listingId);
  }
  return unique(failed);
};

const ensureServicingCreateBookings = async (
  result: CreateAttendeeResult,
  bookings: ListingBooking[],
): Promise<Extract<CreateAttendeeResult, { success: true }>> => {
  const check = await ensureAllBookings(result, bookings.length, "admin");
  if (!check.ok) {
    const names =
      check.reason === "capacity_exceeded"
        ? await joinedListingNames(unfulfilledListingIds(bookings, result))
        : "";
    throw new Error(formatServicingCapacityError(check.reason, names));
  }
  return result as Extract<CreateAttendeeResult, { success: true }>;
};

const normalizedCreateInput = (
  input: ServicingEventInput,
  name: string,
): AttendeeInput => ({
  address: "",
  ...(input.allowOverbook !== undefined
    ? { allowOverbook: input.allowOverbook }
    : {}),
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

const saveServicingAnswers = (
  attendeeId: number,
  answers: ServicingEventInput["questionAnswers"],
): Promise<void> =>
  answers === undefined
    ? Promise.resolve()
    : saveAttendeeAnswers(
        new Map([[attendeeId, { answerIds: answers.map((a) => a.answerId) }]]),
      );

const durationDaysFromRow = (row: ListingAttendeeRow): number | undefined => {
  if (!row.start_at || !row.end_at) return;
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
          order_token: "",
          package_group_id: 0,
          parent_listing_id: 0,
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
  // One LEFT JOIN covers both a booked event (one row per held line) and an
  // orphan with no bookings (a single COALESCEd listing_id=0 row that
  // rowsToServicingEvent filters out) — no separate fallback query needed.
  const rows = await queryAll<ServicingRow>(
    `SELECT ${attendeeColumns("left", ATTENDEE_FIELDS)}, attendee.kind
       FROM attendees AS attendee
       LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
      WHERE attendee.id = ? AND attendee.kind = ?
      ORDER BY listingAttendee.start_at, listingAttendee.listing_id`,
    [id, SERVICING_KIND],
  );
  return rows.length > 0 ? rowsToServicingEvent(rows) : null;
};

export const createServicingEvent = async (
  input: ServicingEventInput,
): Promise<ServicingEvent> => {
  const name = assertServicingInput(input);
  const createResult = await ensureServicingCreateBookings(
    await createAttendeeAtomic(normalizedCreateInput(input, name)),
    input.bookings,
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
  // Map.groupBy keeps first-seen key order, and rows arrive date-then-id
  // ordered, so each group's first row is its earliest booking line and the
  // summaries stay in upcoming order.
  const byAttendee = Map.groupBy(rows, (row) => row.id);
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
        totalQuantity: sumOf(
          (booking: ServicingBookingSummary) => booking.quantity,
        )(bookings),
      };
    }),
  );
};

const getServicingEventRows = (today?: string): Promise<ServicingRow[]> => {
  const upcomingClause =
    today === undefined
      ? ""
      : "AND (listingAttendee.start_at IS NULL OR DATE(listingAttendee.start_at) >= ?)";
  return queryAll<ServicingRow>(
    `SELECT ${attendeeColumns("inner", ATTENDEE_FIELDS)}
       FROM attendees AS attendee
       JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
      WHERE attendee.kind = ?
        AND listingAttendee.quantity > 0
        ${upcomingClause}
      ORDER BY COALESCE(listingAttendee.start_at, attendee.created), attendee.id`,
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

/** The encrypted PII blob a service event stores: its name only, every
 *  customer-only field empty. The single source of the "servicing owns no
 *  contact PII" invariant shared by the edit and its compensating restore. */
const servicingPiiBlob = (name: string, ticketToken: string): Promise<string> =>
  encryptPiiBlob(
    buildPiiBlob({
      address: "",
      email: "",
      lat: "",
      lng: "",
      name,
      payment_id: "",
      phone: "",
      special_instructions: "",
      ticket_token: ticketToken,
    }),
    settings.publicKey,
  );

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
  const restoredPiiBlob = await servicingPiiBlob(
    before.name,
    before.ticketToken,
  );
  await applyAttendeeAtomicEdit(
    id,
    restoredPiiBlob,
    desiredLinesFromExisting(existingBefore),
    true,
  );
  await saveAttendeeAnswers(new Map([[id, answersBefore]]));
};

/** Collapse a batch answer read for one attendee into the {@link AttendeeAnswerSet}
 *  `saveAttendeeAnswers` restores — choice ids plus the decrypted free-text
 *  answers as `{ questionId, text }` pairs, so a compensation re-saves the whole
 *  answer set rather than only its choice half. */
const snapshotAnswerSet = (
  id: number,
  batch: AttendeeAnswersBatch,
): AttendeeAnswerSet => ({
  answerIds: batch.answerIds.get(id) ?? [],
  textAnswers: [
    ...(batch.textAnswers.get(id) ?? new Map<number, string>()),
  ].map(([questionId, text]) => ({ questionId, text })),
});

export const updateServicingEvent = async (
  id: number,
  input: ServicingEventInput,
): Promise<ServicingEvent> => {
  const name = assertServicingEditInput(input);
  const current = await getServicingEvent(id);
  if (!current) throw new Error("servicing event not found");
  // Snapshot the FULL pre-edit answer set — choice ids AND decrypted free-text
  // answers. A choice-only snapshot ({ texts: false }) would let the
  // compensation drop any free-text answer saveAttendeeAnswers deleted, even
  // though the edit is reported as rolled back.
  const [existingBefore, answersBeforeBatch] = await Promise.all([
    loadExistingLines(id),
    getAttendeeAnswersBatch([id], {
      privateKey: await requestKey(),
      texts: true,
    }),
  ]);
  const answersBefore = snapshotAnswerSet(id, answersBeforeBatch);
  const encryptedPiiBlob = await servicingPiiBlob(name, current.ticketToken);
  const editResult = await applyAttendeeAtomicEdit(
    id,
    encryptedPiiBlob,
    desiredLines(input, existingBefore),
    input.allowOverbook ?? false,
  );
  // Every failure shape carries listingIds ([] when no specific listing is to
  // blame), so one throw covers both: capacity failures name their listings,
  // anything else falls through to the formatter's generic/fallback message.
  // (`no_lines` can't actually happen here — the edit input asserter already
  // rejects empty bookings, and desiredLines maps them one-to-one.)
  if (!editResult.success) {
    throw new Error(
      formatServicingCapacityError(
        editResult.reason,
        await joinedListingNames(editResult.listingIds),
      ),
    );
  }
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
  reference?: string | undefined;
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
    KIND.serviceCost,
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
  kind: KIND.serviceCost,
  memo: await encrypt(input.memo),
  occurredAt: input.occurredAt,
  reference:
    input.reference ?? (await legReference([...costReferenceParts(input)])),
  source: costAccount(input.listingId),
});

/** Message thrown when an idempotency key (or a payload-derived reference) is
 *  reused for a service cost whose payload has since changed. Surfaced by the
 *  route as a form error rather than a false success. */
export const COST_REPLAY_MISMATCH =
  "A different service cost was already recorded for this request. " +
  "Reload the page and re-enter the cost.";

/**
 * The transfer id of an existing service cost stored under `reference`, but ONLY
 * when its stored leg matches the submitted **operator-entered** payload —
 * amount, servicing event, listing, and (decrypted) memo. Returns null when no
 * leg is stored for the reference (a fresh cost). Throws
 * {@link COST_REPLAY_MISMATCH} when a leg IS stored but differs: the cost form's
 * per-render idempotency key is an opaque token, so a stale/bfcached form the
 * operator edited before resubmitting would otherwise resolve to the old leg and
 * report a false success while recording nothing. The memo is checked too — a
 * payload-derived reference omits it, so "same amount, changed memo only" must
 * not silently keep the old memo.
 *
 * `occurredAt` is deliberately NOT compared: it isn't an operator-editable cost
 * form field — it's derived (the event's booking date, or `new Date()` for a
 * dateless event). Comparing it would make a legitimate double-submit of a
 * dateless cost (same key, same amount/listing/memo, a millisecond-different
 * server clock) fail as a mismatch, defeating the idempotency key for the exact
 * retry case it exists to cover.
 */
const matchingServiceCostReplayId = async (
  input: RecordServiceCostInput,
  reference: string,
): Promise<number | null> => {
  const stored = await queryOne<{
    transfer_id: number;
    amount: number;
    servicing_attendee_id: number;
    listing_id: number;
    memo: EnvKeyEncrypted;
  }>(
    `SELECT transfer.id AS transfer_id, transfer.amount,
            cost.servicing_attendee_id, cost.listing_id, cost.memo
       FROM transfers AS transfer
       JOIN service_costs AS cost ON cost.transfer_id = transfer.id
      WHERE transfer.reference = ?`,
    [reference],
  );
  if (!stored) return null;
  const matches =
    stored.amount === input.amount &&
    stored.servicing_attendee_id === input.servicingId &&
    stored.listing_id === input.listingId &&
    (await decrypt(stored.memo)) === input.memo;
  if (!matches) throw new Error(COST_REPLAY_MISMATCH);
  return stored.transfer_id;
};

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
  // double-click of the same form re-posts the same reference. Return the
  // already-recorded cost id *before* re-posting — a fresh per-request
  // `occurredAt` would otherwise trip the ledger's replay-equality guard and
  // surface a 500 — but ONLY when the stored leg matches the whole payload, so a
  // reused key with a changed amount/memo/etc. fails loudly instead of reporting
  // a false success.
  const priorId = await matchingServiceCostReplayId(input, transfer.reference);
  if (priorId !== null) return priorId;
  // Post the cost leg AND its first-class `service_costs` record in one
  // transaction, so the per-event cost list can never miss a posted cost (a
  // leg without a service_costs row would affect listing cost but be unlistable).
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
  memo?: EnvKeyEncrypted;
};

const COST_ROW_SELECT =
  "id, source_type, source_id, dest_type, dest_id, amount";

const getCostRow = async (costId: number): Promise<CostRow | null> =>
  queryOne<CostRow>(
    `SELECT ${COST_ROW_SELECT}
       FROM transfers
      WHERE id = ? AND kind = '${KIND.serviceCost}'`,
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
  const legs = await loadServiceCostLegs([listingId]);
  const currentAmount =
    original.amount + (sumAdjustmentsByOriginal(legs).get(costId) ?? 0);
  const delta = update.amount - currentAmount;
  if (delta === 0) return;
  const amount = Math.abs(delta);
  const cost = costAccount(listingId);
  // The edit's event id + reference are hashed from the same tuple, so build it
  // once (currentAmount keeps re-targeting the same amount distinct per edit).
  const editRefParts = [
    "service_cost_edit",
    costId,
    currentAmount,
    update.amount,
  ] as const;
  await postTransfers([
    {
      amount,
      destination: delta > 0 ? WORLD : cost,
      eventGroup: await eventGroup([...editRefParts]),
      kind: KIND.serviceCost,
      memo: await encrypt(`${ADJ_MEMO_PREFIX}${costId}`),
      occurredAt: nowIso(),
      reference: await legReference([...editRefParts]),
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

/** A decoded `service_cost` leg: its id and amount, whether it RAISED the cost
 *  (source is the cost account), and — for an adjustment leg — the id of the
 *  original cost it corrects (null for an original cost leg). */
type DecodedCostLeg = {
  id: number;
  amount: number;
  isIncrease: boolean;
  adjustsOriginalId: number | null;
};

/** Load and decode every `service_cost` leg attributed to any of `listingIds`
 *  in one query, decrypting each memo to classify it as an original cost leg or
 *  an adjustment naming the original it corrects. Shared by {@link editServiceCost}
 *  (current amount of one cost) and {@link getServicingCosts} (current amount of
 *  every cost) so the leg query and the memo classification live in one place. */
const loadServiceCostLegs = async (
  listingIds: number[],
): Promise<DecodedCostLeg[]> => {
  // Both callers pass a non-empty set (getServicingCosts guards on
  // records.length; editServiceCost passes the cost's single listing), so no
  // empty-set guard — an empty `IN ()` would be a caller bug, not a silent [].
  const ids = listingIds.map(String);
  const legs = await queryAll<CostRow>(
    `SELECT ${COST_ROW_SELECT}, memo FROM transfers
      WHERE kind = '${KIND.serviceCost}'
        AND ((source_type = 'cost' AND source_id IN (${inPlaceholders(ids)}))
          OR (dest_type = 'cost' AND dest_id IN (${inPlaceholders(ids)})))
      ORDER BY id`,
    [...ids, ...ids],
  );
  return Promise.all(
    legs.map(async (leg): Promise<DecodedCostLeg> => {
      const match = (await decrypt(leg.memo!)).match(EDIT_COST_MEMO);
      return {
        adjustsOriginalId: match ? Number(match[1]) : null,
        amount: leg.amount,
        id: leg.id,
        isIncrease: leg.source_type === "cost",
      };
    }),
  );
};

/** Fold decoded legs into (original cost id → net signed adjustment): an
 *  increase leg adds its amount, a reduction leg subtracts it; original
 *  (non-adjustment) legs contribute nothing. */
const sumAdjustmentsByOriginal = (
  legs: DecodedCostLeg[],
): Map<number, number> =>
  sumByKey(
    (leg: DecodedCostLeg) => leg.adjustsOriginalId!,
    (leg) => (leg.isIncrease ? leg.amount : -leg.amount),
  )(legs.filter((leg) => leg.adjustsOriginalId !== null));

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
    memo: EnvKeyEncrypted;
  }>(
    "SELECT transfer_id, listing_id, occurred_at, memo FROM service_costs WHERE servicing_attendee_id = ? ORDER BY occurred_at, transfer_id",
    [servicingId],
  );
  if (records.length === 0) return [];
  const legs = await loadServiceCostLegs(
    unique(records.map((r) => r.listing_id)),
  );
  const adjustmentsByOriginal = sumAdjustmentsByOriginal(legs);
  const baseAmountById = new Map(legs.map((leg) => [leg.id, leg.amount]));
  // Build the result as a pure map over `records`, which is already ordered by
  // (occurred_at, transfer_id): Promise.all preserves that input order
  // regardless of which decrypt() resolves first, so the cost list can't
  // shuffle under concurrent decryption.
  return Promise.all(
    records.map(
      async (r): Promise<ServicingCostRecord> => ({
        amount:
          baseAmountById.get(r.transfer_id)! +
          (adjustmentsByOriginal.get(r.transfer_id) ?? 0),
        date: r.occurred_at,
        id: r.transfer_id,
        listingId: r.listing_id,
        memo: await decrypt(r.memo!),
      }),
    ),
  );
};
