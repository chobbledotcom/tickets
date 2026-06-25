import { costAccount, WORLD } from "#shared/accounting/accounts.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
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
import { queryAll, queryOne } from "#shared/db/client.ts";
import {
  type AttendeeAnswerSet,
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

export type UpcomingServicingEvent = {
  date: string | null;
  id: number;
  listingId: number;
  name: string;
  quantity: number;
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
      WHERE a.id = ? AND a.kind = 'servicing'
      ORDER BY ea.start_at, ea.listing_id`,
    [id],
  );
  if (rows.length > 0) return rowsToServicingEvent(rows);
  const orphan = await queryOne<ServicingRow>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}, a.kind
       FROM attendees a
       LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
      WHERE a.id = ? AND a.kind = 'servicing'`,
    [id],
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
  await saveServicingAnswers(id, input.questionAnswers);
  await logActivity(
    `Service event '${name}' created`,
    input.bookings[0]!.listingId,
    id,
  );
  return (await getServicingEvent(id))!;
};

const servicingEventRowsToSummaries = (
  rows: ServicingRow[],
  privateKey: CryptoKey,
): Promise<UpcomingServicingEvent[]> => {
  return Promise.all(
    rows.map(async (row) => {
      const attendee = await decryptAttendeeFields(row, privateKey);
      return {
        date: row.date,
        id: row.id,
        listingId: row.listing_id,
        name: attendee.name,
        quantity: row.quantity,
      };
    }),
  );
};

const getServicingEventRows = (today?: string): Promise<ServicingRow[]> => {
  const upcomingClause =
    today === undefined
      ? ""
      : "AND COALESCE(DATE(ea.start_at), SUBSTR(a.created, 1, 10)) >= ?";
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
): Promise<UpcomingServicingEvent[]> => {
  const rows = await getServicingEventRows();
  return servicingEventRowsToSummaries(rows, privateKey);
};

export const getUpcomingServicingEvents = async (
  privateKey: CryptoKey,
  today: string,
): Promise<UpcomingServicingEvent[]> => {
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

export const updateServicingEvent = async (
  id: number,
  input: ServicingEventInput,
): Promise<ServicingEvent> => {
  const name = assertServicingEditInput(input);
  const current = await getServicingEvent(id);
  if (!current) throw new Error("servicing event not found");
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
    desiredLines(input, await loadExistingLines(id)),
    input.allowOverbook ?? false,
  );
  if (!editResult.success) throw new Error(editResult.reason);
  await saveServicingAnswers(id, input.questionAnswers);
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

const assertServicingHoldsListing = async (
  servicingId: number,
  listingId: number,
): Promise<void> => {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one
       FROM attendees AS attendee
       JOIN listing_attendees AS booking ON booking.attendee_id = attendee.id
      WHERE attendee.id = ?
        AND attendee.kind = 'servicing'
        AND booking.listing_id = ?
      LIMIT 1`,
    [servicingId, listingId],
  );
  if (!row) throw new Error("service cost must target a held listing");
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
  await postTransfers([transfer]);
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
};

const loadCostRow = async (costId: number): Promise<CostRow> => {
  const row = await queryOne<CostRow>(
    `SELECT id, source_type, source_id, dest_type, dest_id, amount
       FROM transfers
      WHERE id = ? AND kind = 'service_cost'`,
    [costId],
  );
  if (!row) throw new Error("service cost not found");
  return row;
};

export const editServiceCost = async (
  costId: number,
  update: { amount: number },
  servicingId?: number,
): Promise<void> => {
  const original = await loadCostRow(costId);
  const listingId = Number(
    original.source_type === "cost" ? original.source_id : original.dest_id,
  );
  if (servicingId !== undefined) {
    await assertServicingHoldsListing(servicingId, listingId);
  }
  const delta = update.amount - original.amount;
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
        update.amount,
      ]),
      kind: "service_cost",
      memo: await encrypt(`edit service cost ${costId}`),
      occurredAt: nowIso(),
      reference: await legReference([
        "service_cost_edit",
        costId,
        update.amount,
      ]),
      source: delta > 0 ? cost : WORLD,
    },
  ]);
};
