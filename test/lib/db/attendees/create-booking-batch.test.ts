import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import { createBookingAtomic, getAttendeesRaw } from "#shared/db/attendees.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

const OCCURRED_AT = "2026-06-24T00:00:00.000Z";

const line = (
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

const order = (overrides: Partial<PricedOrder> = {}): PricedOrder => ({
  extras: [],
  fullSubtotal: 0,
  lines: [],
  modifierApplications: [],
  total: 0,
  ...overrides,
});

/** A surcharge modifier application: bills the attendee `delta` extra.
 *  (scopedSubtotal isn't read on the booking-write path; it satisfies the
 *  ModifierApplication shape.) */
const surcharge = (modifierId: number, delta: number) => ({
  amountApplied: delta,
  delta,
  modifierId,
  name: "Add-on",
  quantity: 1,
  scopedSubtotal: delta,
});

/** The create input for one paid booking of `listingId`. */
const paidInput = (listingId: number, pricePaid: number) => ({
  bookings: [{ listingId, pricePaid, quantity: 1 }],
  email: "batch@example.com",
  name: "Batch",
  paymentId: `pi_${listingId}`,
});

describeWithEnv("db > createBookingAtomic", { db: true }, () => {
  test("posts legs, consumes modifier stock, and finalizes the session in one batch", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const m = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Add-on",
      stock: 5,
    });
    await reserveSession("sess_batch_ok");
    const pricedOrder = order({
      fullSubtotal: 600,
      lines: [line(listing.id, 500, 1)],
      modifierApplications: [surcharge(m.id, 100)],
      total: 600,
    });
    const plan = await bookingBatchPlan(
      [surcharge(m.id, 100)],
      { eventId: "sess_batch_ok", occurredAt: OCCURRED_AT, pricedOrder },
      "sess_batch_ok",
    );

    const result = await createBookingAtomic(paidInput(listing.id, 600), plan);

    expect(result).not.toBe("sold-out");
    if (result === "sold-out" || !result.success)
      throw new Error("expected ok");
    const attendeeId = result.attendees[0]!.id;
    // Gross revenue recognised, surcharge billed, and the £6 paid clears the
    // balance to zero — the legs were posted with the real attendee id.
    expect(await accountBalance(revenueAccount(listing.id))).toBe(500);
    expect(await accountBalance(modifierAccount(m.id))).toBe(100);
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
    // Modifier stock consumed exactly once.
    expect(await modifierUsedQuantities([m.id])).toEqual(new Map([[m.id, 1]]));
    // Session finalized atomically: attendee_id set in the same batch.
    const session = await isSessionProcessed("sess_batch_ok");
    expect(session!.attendee_id).toBe(attendeeId);
  });

  test("returns 'sold-out' and writes nothing when a chosen modifier is sold out", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const m = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Sold out add-on",
      stock: 0,
    });
    await reserveSession("sess_batch_soldout");
    const pricedOrder = order({
      fullSubtotal: 600,
      lines: [line(listing.id, 500, 1)],
      modifierApplications: [surcharge(m.id, 100)],
      total: 600,
    });
    const plan = await bookingBatchPlan(
      [surcharge(m.id, 100)],
      { eventId: "sess_batch_soldout", occurredAt: OCCURRED_AT, pricedOrder },
      "sess_batch_soldout",
    );

    const result = await createBookingAtomic(paidInput(listing.id, 600), plan);

    expect(result).toBe("sold-out");
    // Nothing landed: no attendee, no legs, no stock, session left unresolved.
    expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    expect((await allTransfers()).length).toBe(0);
    expect(await modifierUsedQuantities([m.id])).toEqual(new Map());
    expect((await isSessionProcessed("sess_batch_soldout"))!.attendee_id).toBe(
      null,
    );
  });

  test("returns capacity_exceeded (not sold-out) when the listing is full", async () => {
    const listing = await createTestListing({
      maxAttendees: 0,
      unitPrice: 500,
    });
    const pricedOrder = order({
      fullSubtotal: 500,
      lines: [line(listing.id, 500, 1)],
      total: 500,
    });
    const plan = await bookingBatchPlan([], {
      eventId: "sess_batch_full",
      occurredAt: OCCURRED_AT,
      pricedOrder,
    });

    const result = await createBookingAtomic(paidInput(listing.id, 500), plan);

    expect(result).toEqual({ reason: "capacity_exceeded", success: false });
    expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    expect((await allTransfers()).length).toBe(0);
  });

  test("creates the attendee with no legs, stamp, or finalize for an empty plan", async () => {
    const listing = await createTestListing({ maxAttendees: 5, unitPrice: 0 });
    const plan = await bookingBatchPlan([], {
      eventId: "free-1",
      occurredAt: OCCURRED_AT,
      pricedOrder: order({ lines: [line(listing.id, 0, 1)] }),
    });
    // A zero-everything order maps to no legs at all.
    expect(plan.legs.length).toBe(0);

    const result = await createBookingAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "z@z.z",
        name: "Z",
      },
      plan,
    );

    if (result === "sold-out" || !result.success)
      throw new Error("expected ok");
    expect(result.attendees.length).toBe(1);
    // No money moved, no event-group stamp written.
    expect((await allTransfers()).length).toBe(0);
  });

  test("blames capacity, not the modifiers, when the booking fails but every modifier still has stock", async () => {
    const listing = await createTestListing({
      maxAttendees: 0,
      unitPrice: 500,
    });
    const unlimited = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Unlimited",
      stock: null,
    });
    const plenty = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Plenty",
      stock: 5,
    });
    // A surcharge whose modifier id no longer resolves (deleted mid-checkout) is
    // never the sold-out cause either — exercises the unknown-stock branch.
    const usages = [
      surcharge(unlimited.id, 100),
      surcharge(plenty.id, 100),
      surcharge(999_999, 100),
    ];
    const pricedOrder = order({
      fullSubtotal: 800,
      lines: [line(listing.id, 500, 1)],
      modifierApplications: usages,
      total: 800,
    });
    const plan = await bookingBatchPlan(usages, {
      eventId: "sess_cap_with_stock",
      occurredAt: OCCURRED_AT,
      pricedOrder,
    });

    const result = await createBookingAtomic(paidInput(listing.id, 800), plan);

    // The event is full, but no modifier sold out, so it's a capacity failure.
    expect(result).toEqual({ reason: "capacity_exceeded", success: false });
  });

  test("posts no legs and does not finalize when a multi-listing cart only partly lands", async () => {
    const open = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    const full = await createTestListing({ maxAttendees: 0, unitPrice: 500 });
    await reserveSession("sess_batch_partial");
    const pricedOrder = order({
      fullSubtotal: 1000,
      lines: [line(open.id, 500, 1), line(full.id, 500, 1)],
      total: 1000,
    });
    const plan = await bookingBatchPlan(
      [],
      { eventId: "sess_batch_partial", occurredAt: OCCURRED_AT, pricedOrder },
      "sess_batch_partial",
    );

    const result = await createBookingAtomic(
      {
        bookings: [
          { listingId: open.id, pricePaid: 500, quantity: 1 },
          { listingId: full.id, pricePaid: 500, quantity: 1 },
        ],
        email: "partial@example.com",
        name: "Partial",
      },
      plan,
    );

    // Greedy create: the open listing's booking landed, the full one didn't.
    if (result === "sold-out" || !result.success)
      throw new Error("expected ok");
    expect(result.attendees.length).toBe(1);
    // The all-bookings-landed guard held back every leg and the finalize, so the
    // caller's ensureAllBookings can roll the partial booking back cleanly.
    expect((await allTransfers()).length).toBe(0);
    expect((await isSessionProcessed("sess_batch_partial"))!.attendee_id).toBe(
      null,
    );
  });
});
