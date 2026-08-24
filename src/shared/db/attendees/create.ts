/** Atomic attendee creation across one or more listing bookings. */

/* jscpd:ignore-start */
import { generateTicketToken } from "#crypto/utils.ts";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#db/attendees/booking-slot.ts";
import {
  buildCapacityCheckedInsert,
  checkBatchAvailabilityImpl,
  unfitListingIds,
} from "#db/attendees/capacity/checks.ts";
import {
  ATTENDEE_BY_TOKEN_SQL,
  type AttendeeCreationWork,
  type BookingBatchPlan,
  bookingBatchCondition,
  type PreparedWrite,
  type WriteOutcome,
  writeAsBatch,
  writeAsLedgerBatch,
  writeWithCreationWork,
} from "#db/attendees/create-batch.ts";
import { ATTENDEE_KIND, type AttendeeKind } from "#db/attendees/kind.ts";
import { annotateOrderParents } from "#db/attendees/order-parents.ts";
import { contactFields, encryptAttendeeFields } from "#db/attendees/pii.ts";
import { insert, type SqlStatement } from "#db/client.ts";
import { orderActivityStatements } from "#db/contact-tokens.ts";
import { anyModifierSoldOut } from "#db/modifier-usage.ts";
import type { NumberedSql } from "#db/numbered-statement.ts";
import { compact, unique } from "#fp";
import { addDays } from "#shared/dates.ts";
import { type Attendee, type ContactInfo, clampDurationDays } from "#types";

/* jscpd:ignore-end */

type AttendeeOrderFields = {
  kind?: AttendeeKind | undefined;
  statusId: number | null;
};

export const buildAttendeeInsert = (
  enc: EncryptedAttendeeData,
  order: AttendeeOrderFields,
  piiPaymentSessionId = enc.piiPaymentSessionId,
): SqlStatement =>
  insert("attendees", {
    created: enc.created,
    kind: order.kind ?? ATTENDEE_KIND,
    pii_blob: enc.encryptedPiiBlob,
    pii_payment_session_id: piiPaymentSessionId,
    status_id: order.statusId,
    ticket_token_index: enc.ticketTokenIndex,
  });

const contactInfoFromInput = (input: AttendeeInput): ContactInfo => ({
  address: input.address ?? "",
  email: input.email,
  name: input.name,
  phone: input.phone ?? "",
  special_instructions: input.special_instructions ?? "",
});

const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  listing_id: input.listingId,
  ...contactFields(input),
  attachment_downloads: 0,
  checked_in: false,
  created: input.created,
  date: input.date,
  end_date: input.date
    ? addDays(input.date, clampDurationDays(input.durationDays ?? 1))
    : null,
  kind: input.kind,
  lat: "",
  lng: "",
  package_group_id: input.packageGroupId,
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

const prepareAttendeeWrite = async (
  input: AttendeeInput,
  extraCondition?: NumberedSql,
  piiPaymentSessionId?: string,
): Promise<
  | { ok: true; prepared: PreparedWrite }
  | { ok: false; failure: Extract<CreateAttendeeResult, { success: false }> }
> => {
  const {
    bookings: rawBookings,
    paymentId = "",
    statusId = null,
    allowOverbook = false,
  } = input;
  if (
    rawBookings.length === 0 ||
    rawBookings.some((booking) => (booking.quantity ?? 1) < 0) ||
    hasDuplicateBookingSlot(rawBookings)
  ) {
    // A malformed order, not one listing's capacity shortfall — none is named.
    return {
      failure: { listingIds: [], reason: "capacity_exceeded", success: false },
      ok: false,
    };
  }

  const bookings = await annotateOrderParents(
    rawBookings,
    input.parentIdsByChild,
  );
  const contactInfo = contactInfoFromInput(input);
  const enc = await encryptAttendeeFields(
    {
      ...contactInfo,
      paymentId,
    },
    input.ticketToken ?? generateTicketToken(),
  );

  const bookingStatements = bookings.map((booking) => {
    const statement = buildCapacityCheckedInsert(
      booking,
      (bind) => ATTENDEE_BY_TOKEN_SQL.replace("?", bind(enc.ticketTokenIndex)),
      allowOverbook,
      extraCondition,
    );
    return statement;
  });
  const hasRealBooking = bookings.some(
    (booking) => (booking.quantity ?? 1) > 0,
  );
  const activityStatements = hasRealBooking
    ? await orderActivityStatements(
        contactInfo.email,
        contactInfo.phone,
        input.source ?? "public",
        enc.ticketToken,
      )
    : [];

  return {
    ok: true,
    prepared: {
      activityStatements,
      attendeeInsert: buildAttendeeInsert(
        enc,
        {
          kind: input.kind,
          statusId,
        },
        piiPaymentSessionId,
      ),
      bookingStatements,
      enc,
    },
  };
};

const finishAttendeeWrite = (
  written: WriteOutcome,
  input: AttendeeInput,
  enc: EncryptedAttendeeData,
): CreateAttendeeResult => {
  const contactInfo = contactInfoFromInput(input);
  return {
    attendees: input.bookings.map((booking) =>
      buildAttendeeResult({
        insertId: written.insertId,
        listingId: booking.listingId,
        ...contactInfo,
        created: enc.created,
        date: booking.date ?? null,
        ...(booking.durationDays !== undefined
          ? { durationDays: booking.durationDays }
          : {}),
        kind: input.kind ?? ATTENDEE_KIND,
        packageGroupId: booking.packageGroupId ?? 0,
        paymentId: input.paymentId ?? "",
        pricePaid: booking.pricePaid ?? 0,
        quantity: booking.quantity ?? 1,
        remainingBalance: input.remainingBalance ?? 0,
        statusId: input.statusId ?? null,
        ticketToken: enc.ticketToken,
        ticketTokenIndex: enc.ticketTokenIndex,
      }),
    ),
    success: true,
  };
};

type CreateStrategy<R extends CreateAttendeeResult | "sold-out"> = {
  condition?: NumberedSql;
  noBooking: () => R | Promise<R>;
  piiPaymentSessionId?: string | undefined;
  write: (prepared: PreparedWrite) => Promise<WriteOutcome | null>;
};

const createWith =
  <R extends CreateAttendeeResult | "sold-out">(strategy: CreateStrategy<R>) =>
  async (input: AttendeeInput): Promise<CreateAttendeeResult | R> => {
    const prepared = await prepareAttendeeWrite(
      input,
      strategy.condition,
      strategy.piiPaymentSessionId,
    );
    if (!prepared.ok) return prepared.failure;
    const written = await strategy.write(prepared.prepared);
    return written
      ? finishAttendeeWrite(written, input, prepared.prepared.enc)
      : strategy.noBooking();
  };

/** The first booking that does not fit on top of the bookings before it, the
 * way the write batch met them: each prefix of the order goes through the
 * whole-order availability check, so demand the lines add up between
 * themselves — a shared group limit, most of all — counts too. A checkout
 * books every dated line on the one day the customer picked, so one shared
 * day covers them; the rare multi-day creation (an operator's hand-built
 * one) falls back to checking each line alone. */
const firstUnfitInOrder = async (
  bookings: AttendeeInput["bookings"],
): Promise<number[]> => {
  const items = bookings.map((booking) => ({
    durationDays: booking.durationDays ?? 1,
    listingId: booking.listingId,
    quantity: booking.quantity ?? 1,
  }));
  const days = unique(compact(bookings.map((booking) => booking.date)));
  try {
    if (days.length > 1) {
      return await unfitListingIds(
        items.map((item, index) => ({
          ...item,
          date: bookings[index]!.date ?? null,
        })),
      );
    }
    for (let end = 1; end <= items.length; end++) {
      if (!(await checkBatchAvailabilityImpl(items.slice(0, end), days[0]))) {
        return [bookings[end - 1]!.listingId];
      }
    }
  } catch {
    // The refusal already stands; this read only picks the name. A line the
    // check cannot answer for — its listing gone before this read, or never
    // real — keeps the refusal and names no listing, the documented fallback.
  }
  return [];
};

/** The refusal a failed write answers with. The guarded batch cannot say
 * which statement it aborted on, so the order is asked again as a read and
 * the first line that does not fit is named. A race that freed the room
 * again before this read names none. */
const capacityFailure = async (
  bookings: AttendeeInput["bookings"],
): Promise<CreateAttendeeResult> => ({
  listingIds: await firstUnfitInOrder(bookings),
  reason: "capacity_exceeded",
  success: false,
});

export const createAttendeeAtomicImpl = (
  input: AttendeeInput,
  creationWork?: AttendeeCreationWork,
): Promise<CreateAttendeeResult> =>
  createWith<CreateAttendeeResult>({
    noBooking: () => capacityFailure(input.bookings),
    write: (prepared) =>
      creationWork
        ? writeWithCreationWork(prepared, creationWork)
        : writeAsBatch(prepared),
  })(input);

export type { AttendeeCreationWork, BookingBatchPlan };

const provenPiiPaymentSession = (
  input: AttendeeInput,
  plan: BookingBatchPlan,
): string | undefined => {
  const source = plan.finalize;
  if (source === undefined || source.paymentReference === null) {
    return;
  }
  if ((input.paymentId ?? "") !== source.paymentReference.reference) {
    throw new Error(
      `Payment session ${source.sessionId} does not match the attendee payment id`,
    );
  }
  return source.sessionId;
};

export const createBookingAtomic = (
  input: AttendeeInput,
  plan: BookingBatchPlan,
): Promise<CreateAttendeeResult | "sold-out"> =>
  createWith<CreateAttendeeResult | "sold-out">({
    condition: bookingBatchCondition(plan),
    noBooking: async () =>
      (await anyModifierSoldOut(plan.usages))
        ? "sold-out"
        : capacityFailure(input.bookings),
    piiPaymentSessionId: provenPiiPaymentSession(input, plan),
    write: (prepared) => writeAsLedgerBatch(prepared, plan),
  })(input);
