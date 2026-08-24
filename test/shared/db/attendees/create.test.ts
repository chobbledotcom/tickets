import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
} from "#accounting/accounts.ts";
import { mapBooking } from "#accounting/mappers.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
import {
  type BookingBatchPlan,
  createBookingAtomic,
} from "#db/attendees/create.ts";
import { queryOne, withTransaction } from "#db/client.ts";
import { modifierUsedQuantities } from "#db/modifier-usage.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildPlan,
  expectBookingOk,
  expectCapacityExceeded,
  expectNothingWritten,
  pricedLine as line,
  OCCURRED_AT,
  paidInput,
  storedEventGroup,
  surcharge,
} from "#test-utils/db-helpers/attendee-creation.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  getProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

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
    const { plan } = await buildPlan({
      eventId: "sess_batch_ok",
      fullSubtotal: 600,
      lines: [line(listing.id, 500, 1)],
      sessionId: "sess_batch_ok",
      total: 600,
      usages: [surcharge(m.id, 100)],
    });

    const result = await createBookingAtomic(
      {
        ...paidInput(listing.id, 600),
        paymentId: "pi_sess_batch_ok",
      },
      plan,
    );

    const ok = expectBookingOk(result);
    const attendeeId = ok.attendees[0]!.id;
    // Gross revenue recognised, surcharge billed, and the £6 paid clears the
    // balance to zero — the legs were posted with the real attendee id.
    expect(await accountBalance(revenueAccount(listing.id))).toBe(500);
    expect(await accountBalance(modifierAccount(m.id))).toBe(100);
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
    // Modifier stock consumed exactly once.
    expect(await modifierUsedQuantities([m.id])).toEqual(new Map([[m.id, 1]]));
    // Session finalized atomically: attendee_id set in the same batch.
    const session = await getProcessedPayment("sess_batch_ok");
    expect(session!.attendee_id).toBe(attendeeId);
    expect(
      await queryOne<{ pii_payment_session_id: string }>(
        "SELECT pii_payment_session_id FROM attendees WHERE id = ?",
        [attendeeId],
      ),
    ).toEqual({ pii_payment_session_id: "sess_batch_ok" });
    // The booking row is stamped with the legs' event group, so the per-row
    // amount-paid projection resolves exactly this booking's legs.
    expect(plan.legs.length).toBeGreaterThan(0);
    expect(await storedEventGroup(attendeeId)).toBe(plan.legs[0]!.eventGroup);
  });

  test("refuses payment provenance that does not match the encrypted payment id", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const { plan } = await buildPlan({
      eventId: "sess_mismatched_payment",
      fullSubtotal: 500,
      lines: [line(listing.id, 500, 1)],
      sessionId: "sess_mismatched_payment",
      total: 500,
    });

    const wrongPayment = paidInput(listing.id, 500);
    const { paymentId: _paymentId, ...missingPayment } = wrongPayment;
    const expectProvenanceRefused = (
      input: Parameters<typeof createBookingAtomic>[0],
      candidatePlan: BookingBatchPlan = plan,
    ): void => {
      expect(() => createBookingAtomic(input, candidatePlan)).toThrow(
        "Payment session sess_mismatched_payment does not match the attendee payment id",
      );
    };
    expectProvenanceRefused(wrongPayment);
    expectProvenanceRefused(missingPayment);
    expectProvenanceRefused(missingPayment, {
      ...plan,
      finalize: {
        ...plan.finalize!,
        paymentReference: taggedPaymentReference("mutated"),
      },
    });

    await expectNothingWritten(listing.id, 0);
    expect(
      (await getProcessedPayment("sess_mismatched_payment"))!.attendee_id,
    ).toBe(null);
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
    const { plan } = await buildPlan({
      eventId: "sess_batch_soldout",
      fullSubtotal: 600,
      lines: [line(listing.id, 500, 1)],
      sessionId: "sess_batch_soldout",
      total: 600,
      usages: [surcharge(m.id, 100)],
    });

    const result = await createBookingAtomic(
      {
        ...paidInput(listing.id, 600),
        paymentId: "pi_sess_batch_soldout",
      },
      plan,
    );

    expect(result).toBe("sold-out");
    // Nothing landed: no attendee, no legs, no stock, session left unresolved.
    await expectNothingWritten(listing.id, 0);
    expect(await modifierUsedQuantities([m.id])).toEqual(new Map());
    expect((await getProcessedPayment("sess_batch_soldout"))!.attendee_id).toBe(
      null,
    );
  });

  test("returns capacity_exceeded (not sold-out) when the listing is full", async () => {
    const listing = await createTestListing({
      maxAttendees: 0,
      unitPrice: 500,
    });
    const { plan } = await buildPlan({
      eventId: "sess_batch_full",
      fullSubtotal: 500,
      lines: [line(listing.id, 500, 1)],
      total: 500,
    });

    await expectCapacityExceeded(plan, listing.id, 500, 0);
  });

  test("creates the attendee with no legs, stamp, or finalize for an empty plan", async () => {
    const listing = await createTestListing({ maxAttendees: 5, unitPrice: 0 });
    const { plan } = await buildPlan({
      eventId: "free-1",
      lines: [line(listing.id, 0, 1)],
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

    const ok = expectBookingOk(result);
    expect(ok.attendees.length).toBe(1);
    // No money moved, no event-group stamp written.
    expect((await allTransfers()).length).toBe(0);
    expect(await storedEventGroup(ok.attendees[0]!.id)).toBe("");
  });

  test("postBookingLegsTx stamps a one-leg owed booking's event group", async () => {
    // The transactional poster (owed bookings, manual adds) — distinct from
    // the batch path above. An owed booking posts exactly one sale leg, so
    // the stamp must come from the first (only) leg.
    const listing = await createTestListing({ maxAttendees: 5, unitPrice: 0 });
    const { plan } = await buildPlan({
      eventId: "owed-stamp",
      lines: [line(listing.id, 0, 1)],
    });
    const result = await createBookingAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "o@o.o",
        name: "O",
      },
      plan,
    );
    const attendeeId = expectBookingOk(result).attendees[0]!.id;

    const legs = await mapBooking({
      amountPaid: 0,
      attendeeId,
      bookingFee: 0,
      eventId: `booking-${attendeeId}`,
      lines: [{ gross: 500, listingId: listing.id }],
      modifiers: [],
      occurredAt: OCCURRED_AT,
    });
    expect(legs.length).toBe(1);
    await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, legs));

    expect(await storedEventGroup(attendeeId)).toBe(legs[0]!.eventGroup);
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(-500);
  });

  test("postBookingLegsTx leaves the stamp empty and posts nothing for no legs", async () => {
    const listing = await createTestListing({ maxAttendees: 5, unitPrice: 0 });
    const { plan } = await buildPlan({
      eventId: "owed-empty",
      lines: [line(listing.id, 0, 1)],
    });
    const result = await createBookingAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "e@e.e",
        name: "E",
      },
      plan,
    );
    const attendeeId = expectBookingOk(result).attendees[0]!.id;
    const transfersBefore = (await allTransfers()).length;

    await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, []));

    expect(await storedEventGroup(attendeeId)).toBe("");
    expect((await allTransfers()).length).toBe(transfersBefore);
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
    const { plan } = await buildPlan({
      eventId: "sess_cap_with_stock",
      fullSubtotal: 800,
      lines: [line(listing.id, 500, 1)],
      total: 800,
      usages,
    });

    // The event is full, but no modifier sold out, so it's a capacity failure.
    await expectCapacityExceeded(plan, listing.id, 800, 0);
  });

  test("refuses to create a booking when the payment event already has ledger legs", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const { plan } = await buildPlan({
      eventId: "sess_batch_existing_ledger",
      fullSubtotal: 500,
      lines: [line(listing.id, 500, 1)],
      sessionId: "sess_batch_existing_ledger",
      total: 500,
    });
    await postTransfers(plan.legs);

    const result = await createBookingAtomic(
      {
        ...paidInput(listing.id, 500),
        paymentId: "pi_sess_batch_existing_ledger",
      },
      plan,
    );
    // Not a capacity shortfall — the room is fine, the ledger event already
    // exists — so the refusal names no listing.
    expect(result).toEqual({
      listingIds: [],
      reason: "capacity_exceeded",
      success: false,
    });
    await expectNothingWritten(listing.id, plan.legs.length);
    expect(
      (await getProcessedPayment("sess_batch_existing_ledger"))!.attendee_id,
    ).toBe(null);
  });
});
