import { expect } from "@std/expect";
import {
  attendeeStatuses,
  getPublicDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { pricePaidFromLedger } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

/** Turn the seeded public-default status into a reservation charging `amount`. */
export const setPublicReservation = async (amount: string): Promise<number> => {
  await getDb().execute({
    args: [amount],
    sql: "UPDATE attendee_statuses SET is_reservation = 1, reservation_amount = ? WHERE is_public_default = 1",
  });
  attendeeStatuses.invalidate();
  const status = await getPublicDefaultStatus();
  return status!.id;
};

/** Stub a paid Stripe checkout session with the given metadata and total. The
 * metadata is signed at `amountTotal` (as production checkout does) so the
 * session classifies as trusted — an unsigned session would now be ignored. */
export const stubPaidSession = (
  id: string,
  metadata: Record<string, string>,
  amountTotal: number,
) =>
  stubRetrieveCheckoutSession({
    amountTotal,
    metadata: signMeta(metadata, amountTotal),
    paymentIntent: `pi_${id}`,
    sessionId: id,
  });

/** The most recently created attendee's plaintext reservation columns. */
export const latestAttendee = async (): Promise<{
  id: number;
  statusId: number | null;
  remainingBalance: number;
  pricePaid: number;
}> => {
  const { rows } = await getDb().execute(
    "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
  );
  const id = Number(rows[0]!.id);
  const state = await getAttendeeBalanceState(id);
  // price_paid is a ledger projection now (the booking's gross sale leg), not a
  // stored column. For a reservation this is the gross sale, not the deposit —
  // the accepted gross-sale divergence (deposit accuracy returns in concern 5).
  const paid = await getDb().execute({
    args: [id],
    sql: `SELECT ${pricePaidFromLedger(
      "listing_attendees.attendee_id",
      "listing_attendees.listing_id",
      "listing_attendees.ledger_event_group",
      "listing_attendees.id",
    )} FROM listing_attendees WHERE attendee_id = ?`,
  });
  return {
    id,
    pricePaid: Number(paid.rows[0]!.price_paid),
    remainingBalance: state!.remainingBalance,
    statusId: state!.statusId,
  };
};

export const attendeeCount = async (): Promise<number> => {
  const { rows } = await getDb().execute("SELECT COUNT(*) AS c FROM attendees");
  return Number(rows[0]!.c);
};

export const modifierUsageCount = async (
  modifierId: number,
): Promise<number> => {
  const { rows } = await getDb().execute({
    args: [modifierId],
    sql: "SELECT COALESCE(SUM(quantity), 0) AS c FROM modifier_usages WHERE modifier_id = ?",
  });
  return Number(rows[0]!.c);
};

/** Create a listing plus a one-unit, stock-limited discount modifier whose unit
 * is consumed by a concurrent order — simulated with an AFTER INSERT trigger on
 * attendees — so the checkout's own consumeModifierStock loses the race and
 * rolls the just-created attendee back. The discount zeroes the total, routing
 * the order through the free path. `fields` selects an email or phone listing. */
export const setupSoldOutModifierRace = async (
  fields: "email" | "phone" = "email",
) => {
  const listing = await createTestListing({
    fields,
    maxAttendees: 10,
    thankYouUrl: "https://example.com",
    unitPrice: 1000,
  });
  const modifier = await modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 10,
    direction: "discount",
    name: "Comp",
    stock: 1,
  });
  // Simulate the race: a *different*, concurrent order consumes the modifier's
  // last unit between pricing and our commit. Its usage lands on that other
  // order's attendee (a sentinel id, never ours), so it stands after our order
  // rolls back — exactly as a real competing booking's stock would. Firing on our
  // attendee INSERT (just before the booking insert in the batch) is only the
  // hook for "stock gone by commit time"; it must not attach to NEW.id, or it
  // would look like our own consumption.
  await getDb().execute(
    `CREATE TRIGGER test_consume_modifier_before_order
     AFTER INSERT ON attendees
     BEGIN
       INSERT INTO modifier_usages
         (modifier_id, attendee_id, quantity, amount_applied, created)
       VALUES (${modifier.id}, 999999, 1, 1000, '2024-01-01T00:00:00Z');
     END`,
  );
  return { listing, modifier };
};

/** Total recorded contact activity across every contact. Zero means a
 * rolled-back order left no phantom visit or booking behind — for any identity,
 * email or phone — without the test needing to know which hash was used. */
export const totalContactActivity = async (): Promise<{
  visits: number;
  bookings: number;
}> => {
  const { rows } = await getDb().execute(
    "SELECT COALESCE(SUM(visits), 0) AS visits, COALESCE(SUM(public_booking_count), 0) AS bookings FROM contact_preferences",
  );
  return {
    bookings: Number(rows[0]!.bookings),
    visits: Number(rows[0]!.visits),
  };
};

export const modifierUsageAmount = async (
  modifierId: number,
): Promise<number> => {
  const { rows } = await getDb().execute({
    args: [modifierId],
    sql: "SELECT COALESCE(SUM(amount_applied), 0) AS c FROM modifier_usages WHERE modifier_id = ?",
  });
  return Number(rows[0]!.c);
};

export const modifierRefs = (id: number, quantity = 1): string =>
  JSON.stringify([{ i: id, q: quantity }]);

/** Submit a plain buyer order for one unit of `listing` — the default
 * quantity/email/name shape shared by every test that completes a real
 * booking (rather than inspecting a checkout intent). `fields` overrides or
 * extends the defaults, e.g. to add an add-on or swap email for phone. */
export const submitBuyerOrder = (
  listing: { id: number; slug: string },
  fields: Record<string, string> = {},
) =>
  submitTicketForm(listing.slug, {
    [`quantity_${listing.id}`]: "1",
    email: "buyer@example.com",
    name: "Buyer",
    ...fields,
  });

/** A 10%-of-subtotal "Service charge" modifier, folded automatically into
 * every booking (not an opt-in add-on). */
export const addServiceCharge = () =>
  modifiersTable.insert({
    calcKind: "percent",
    calcValue: 10,
    direction: "charge",
    name: "Service charge",
  });

/** Create a modifier that only applies when the buyer opts in (an add-on),
 * rather than one folded automatically into every booking. */
export const createOptionalAddOn = async (calcValue = 5) => {
  const addOn = await modifiersTable.insert({
    calcKind: "fixed",
    calcValue,
    direction: "charge",
    name: "Programme",
  });
  await getDb().execute({
    args: ["optional", addOn.id],
    sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
  });
  return addOn;
};

/** A fixed £0.05 "Programme" charge folded automatically into every booking
 * (as opposed to `createOptionalAddOn`'s buyer-selected version). `fields`
 * extends the insert, e.g. to zero out its stock. */
export const createProgrammeCharge = (
  fields: Partial<Parameters<typeof modifiersTable.insert>[0]> = {},
) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Programme",
    ...fields,
  });

/** The "SAVE10" promo-code discount shared by every test that prices a
 * booking through a 10%-off code rather than an automatic modifier. */
export const createSave10Promo = () =>
  modifiersTable.insert({
    calcKind: "percent",
    calcValue: 10,
    direction: "discount",
    name: "SAVE10",
    trigger: "code",
  });

/** Set up Stripe plus a reservation-ready listing: the shared preamble behind
 * every checkout/webhook test in this suite. `unitPrice` defaults to a plain
 * £10.00 ticket; omitting `reservationAmount` leaves the seeded public
 * default at its non-reservation, full-payment setting. */
export const setupReservationListing = async (
  opts: {
    bookingFee?: string;
    reservationAmount?: string;
    unitPrice?: number;
  } = {},
) => {
  await setupStripe();
  if (opts.bookingFee !== undefined) {
    await settings.update.bookingFee(opts.bookingFee);
  }
  if (opts.reservationAmount !== undefined) {
    await setPublicReservation(opts.reservationAmount);
  }
  return createTestListing({
    maxAttendees: 10,
    thankYouUrl: "https://example.com",
    unitPrice: opts.unitPrice ?? 1000,
  });
};

/** Verify a checkout webhook kept a sold-out or price-mismatched booking as a
 * refunded, quantity-0 placeholder: no add-on stock consumed, the payment
 * refunded, and a system note left behind. Returns the listing's attendees
 * (a single placeholder row) so callers can layer on further assertions. */
export const expectRefundedPlaceholder = async (
  listing: { id: number },
  addOnId: number,
  refund: { calls: Array<{ args: unknown[] }> },
  paymentIntentId: string,
  responseText: string,
): Promise<Array<{ id: number }>> => {
  expect(responseText).toContain("saved your details");
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listing.id);
  expect(attendees.length).toBe(1);
  // The placeholder posts no sale leg, so the still-sold-out add-on is not
  // consumed.
  expect(await modifierUsageCount(addOnId)).toBe(0);
  expect(refund.calls[0]!.args).toEqual([paymentIntentId]);
  expect(refund.calls.length).toBe(1);
  const { getNoteRows } = await import("#shared/db/system-notes.ts");
  expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
  return attendees;
};
