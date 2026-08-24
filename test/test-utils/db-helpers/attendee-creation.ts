import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { allTransfers } from "#accounting/queries.ts";
import type {
  AttendeeInput,
  CreateAttendeeResult,
} from "#db/attendee-types.ts";
import {
  type BookingBatchPlan,
  createBookingAtomic,
} from "#db/attendees/create.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { requireOne } from "#db/client.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type {
  ModifierApplication,
  PricedLine,
  PricedOrder,
} from "#shared/checkout-pricing.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";
import type { Attendee } from "#types";

type SuccessfulCreate = Extract<
  Awaited<ReturnType<typeof createBookingAtomic>>,
  { success: true }
>;

export const expectBookingOk = (
  result: Awaited<ReturnType<typeof createBookingAtomic>>,
): SuccessfulCreate => {
  assert(result !== "sold-out", "Expected attendee creation to succeed");
  assert(result.success, "Expected attendee creation to succeed");
  return result;
};

/** The one attendee a successful create returned, checked rather than assumed. */
export const requireAttendee = (result: CreateAttendeeResult): Attendee => {
  assert(result.success, "Expected attendee creation to succeed");
  assert(
    result.attendees.length === 1,
    "Expected the create to return exactly one attendee",
  );
  const attendee = result.attendees[0];
  assert(attendee !== undefined, "Expected the create to return one attendee");
  return attendee;
};

export const OCCURRED_AT = "2026-06-24T00:00:00.000Z";

export const pricedLine = (
  listingId: number,
  unitPrice: number,
  quantity: number,
): PricedLine => ({
  chargedUnitAmount: unitPrice,
  item: {
    listingId,
    name: `L${listingId}`,
    quantity,
    slug: `l${listingId}`,
    unitPrice,
  },
  quantity,
});

const pricedOrder = (overrides: Partial<PricedOrder> = {}): PricedOrder => ({
  extras: [],
  fullSubtotal: 0,
  lines: [],
  modifierApplications: [],
  total: 0,
  ...overrides,
});

export const surcharge = (
  modifierId: number,
  delta: number,
): ModifierApplication => ({
  amountApplied: delta,
  delta,
  modifierId,
  name: "Add-on",
  quantity: 1,
  scopedSubtotal: delta,
});

export const paidInput = (
  listingId: number,
  pricePaid: number,
): AttendeeInput => ({
  bookings: [{ listingId, pricePaid, quantity: 1 }],
  email: "batch@example.com",
  name: "Batch",
  paymentId: `pi_${listingId}`,
});

export const buildPlan = async (opts: {
  eventId: string;
  lines: PricedLine[];
  fullSubtotal?: number;
  total?: number;
  usages?: ModifierApplication[];
  sessionId?: string;
}): Promise<{ pricedOrder: PricedOrder; plan: BookingBatchPlan }> => {
  if (opts.sessionId) await reserveSession(opts.sessionId);
  const usages = opts.usages ?? [];
  const order = pricedOrder({
    fullSubtotal: opts.fullSubtotal ?? 0,
    lines: opts.lines,
    modifierApplications: usages,
    total: opts.total ?? 0,
  });
  const plan = await bookingBatchPlan(
    usages,
    { eventId: opts.eventId, occurredAt: OCCURRED_AT, pricedOrder: order },
    opts.sessionId
      ? {
          paymentReference: taggedPaymentReference(`pi_${opts.sessionId}`),
          sessionId: opts.sessionId,
        }
      : undefined,
  );
  return { plan, pricedOrder: order };
};

export const expectNothingWritten = async (
  listingId: number,
  transferCount: number,
): Promise<void> => {
  expect((await getAttendeesRaw(listingId)).length).toBe(0);
  expect(await allTransfers()).toHaveLength(transferCount);
};

export const expectCapacityExceeded = async (
  plan: BookingBatchPlan,
  listingId: number,
  pricePaid: number,
  transferCount: number,
): Promise<void> => {
  const result = await createBookingAtomic(
    paidInput(listingId, pricePaid),
    plan,
  );
  // The refusal names the listing that is out of room.
  expect(result).toEqual({
    listingIds: [listingId],
    reason: "capacity_exceeded",
    success: false,
  });
  await expectNothingWritten(listingId, transferCount);
};

export const storedEventGroup = async (attendeeId: number): Promise<string> => {
  const row = await requireOne<{ ledger_event_group: string }>(
    "SELECT ledger_event_group FROM listing_attendees AS attendee WHERE attendee_id = ?",
    [attendeeId],
  );
  return row.ledger_event_group;
};
