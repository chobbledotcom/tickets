/** Atomic attendee creation across one or more listing bookings. */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { addDays } from "#shared/dates.ts";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#shared/db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#shared/db/attendees/booking-slot.ts";
import { buildCapacityCheckedInsert } from "#shared/db/attendees/capacity/checks.ts";
import {
  ATTENDEE_BY_TOKEN_SQL,
  type AttendeeCreationWork,
  bookingBatchCondition,
  type BookingBatchPlan,
  type PreparedWrite,
  writeAsBatch,
  writeAsLedgerBatch,
  type WriteOutcome,
  writeWithCreationWork,
} from "#shared/db/attendees/create-batch.ts";
import { ATTENDEE_KIND, type AttendeeKind } from "#shared/db/attendees/kind.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import {
  contactFields,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import { insert, type SqlStatement } from "#shared/db/client.ts";
import { orderActivityStatements } from "#shared/db/contact-tokens.ts";
import { anyModifierSoldOut } from "#shared/db/modifier-usage.ts";
import {
  type Attendee,
  clampDurationDays,
  type ContactInfo,
} from "#shared/types.ts";

/* jscpd:ignore-end */

type AttendeeOrderFields = {
  kind?: AttendeeKind | undefined;
  statusId: number | null;
};

export const buildAttendeeInsert = (
  enc: EncryptedAttendeeData,
  order: AttendeeOrderFields,
): SqlStatement =>
  insert("attendees", {
    created: enc.created,
    kind: order.kind ?? ATTENDEE_KIND,
    pii_blob: enc.encryptedPiiBlob,
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
  extraCondition?: SqlStatement,
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
    return {
      failure: { reason: "capacity_exceeded", success: false },
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
      pricePaid: bookings[0]!.pricePaid ?? 0,
    },
    input.ticketToken ?? generateTicketToken(),
  );

  const bookingStatements = bookings.map((booking) => {
    const statement = buildCapacityCheckedInsert(
      booking,
      ATTENDEE_BY_TOKEN_SQL,
      enc.ticketTokenIndex,
      allowOverbook,
    );
    return {
      args: [
        ...statement.args,
        ...(extraCondition && !allowOverbook ? extraCondition.args : []),
      ] as InValue[],
      sql: extraCondition && !allowOverbook
        ? `${statement.sql} AND (${extraCondition.sql})`
        : statement.sql,
    };
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
      attendeeInsert: buildAttendeeInsert(enc, {
        kind: input.kind,
        statusId,
      }),
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
      })
    ),
    success: true,
  };
};

type CreateStrategy<R extends CreateAttendeeResult | "sold-out"> = {
  condition?: SqlStatement;
  noBooking: () => R | Promise<R>;
  write: (prepared: PreparedWrite) => Promise<WriteOutcome | null>;
};

const createWith =
  <R extends CreateAttendeeResult | "sold-out">(strategy: CreateStrategy<R>) =>
  async (input: AttendeeInput): Promise<CreateAttendeeResult | R> => {
    const prepared = await prepareAttendeeWrite(input, strategy.condition);
    if (!prepared.ok) return prepared.failure;
    const written = await strategy.write(prepared.prepared);
    return written
      ? finishAttendeeWrite(written, input, prepared.prepared.enc)
      : strategy.noBooking();
  };

const capacityFailure = (): CreateAttendeeResult => ({
  reason: "capacity_exceeded",
  success: false,
});

export const createAttendeeAtomicImpl = (
  input: AttendeeInput,
  creationWork?: AttendeeCreationWork,
): Promise<CreateAttendeeResult> =>
  createWith<CreateAttendeeResult>({
    noBooking: capacityFailure,
    write: (prepared) =>
      creationWork
        ? writeWithCreationWork(prepared, creationWork)
        : writeAsBatch(prepared),
  })(input);

export type { AttendeeCreationWork, BookingBatchPlan };

export const createBookingAtomic = (
  input: AttendeeInput,
  plan: BookingBatchPlan,
): Promise<CreateAttendeeResult | "sold-out"> =>
  createWith<CreateAttendeeResult | "sold-out">({
    condition: bookingBatchCondition(plan),
    noBooking: async () =>
      (await anyModifierSoldOut(plan.usages)) ? "sold-out" : capacityFailure(),
    write: (prepared) => writeAsLedgerBatch(prepared, plan),
  })(input);
