import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { OrderBooking } from "#shared/booking-lines.ts";
import { activateStagedBooking } from "#shared/db/attendees/activate.ts";
import { refusalReason } from "#shared/db/attendees/activation-refusal.ts";
import type { FinalizedBookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { settings } from "#shared/db/settings.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const setupStage = async (sessionId: string, maxAttendees = 2) => {
  const listing = await createTestListing({ maxAttendees, unitPrice: 1000 });
  const intent = checkoutIntent({
    items: [
      checkoutItem({
        listingId: listing.id,
        name: listing.name,
        slug: listing.slug,
      }),
    ],
  });
  const stage = await stageCheckout(sessionId, "stripe", intent);
  const bookings: OrderBooking[] = [
    {
      date: null,
      durationDays: 1,
      listingId: listing.id,
      pricePaid: 1000,
      quantity: 1,
    },
  ];
  const input = {
    address: intent.address,
    bookings,
    email: intent.email,
    name: intent.name,
    paymentId: `pi_${sessionId}`,
    phone: intent.phone,
    special_instructions: intent.special_instructions,
  };
  const plan: FinalizedBookingBatchPlan = {
    finalize: {
      paymentReference: `pi_${sessionId}`,
      sessionId,
    },
    legs: [],
    usages: [],
  };
  return { input, listing, plan, stage };
};

const activate = async (sessionId: string) => {
  const setup = await setupStage(sessionId);
  await reserveSession(sessionId);
  return {
    ...setup,
    run: () =>
      activateStagedBooking(
        sessionId,
        setup.stage.attendeeId,
        setup.stage.ticketToken,
        setup.input,
        setup.plan,
      ),
  };
};

/** Run an activation expected to throw `message`, then assert the whole thing
 * rolled back — the staged row stays at quantity 0, never claimed against a
 * stage the activation couldn't finish. */
const expectActivationRollback = async (
  setup: { run: () => Promise<unknown>; stage: { attendeeId: number } },
  message: string,
): Promise<void> => {
  await expect(setup.run()).rejects.toThrow(message);
  const row = await execute(
    "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
    [setup.stage.attendeeId],
  );
  expect(row.rows.map((value) => value.quantity)).toEqual([0]);
};

describeWithEnv("db > staged booking activation", { db: true }, () => {
  test("activates the staged row", async () => {
    const setup = await activate("cs_activate_ok");

    expect(await setup.run()).toEqual({ success: true });
    const row = await execute(
      `SELECT stage.state, booking.quantity
       FROM checkout_stages AS stage
       JOIN listing_attendees AS booking
         ON booking.attendee_id = stage.attendee_id
       WHERE stage.payment_session_id = ?`,
      ["cs_activate_ok"],
    );
    expect(row.rows.map((value) => [value.state, value.quantity])).toEqual([
      ["booked", 1],
    ]);
    const attendee = await getAttendeeRaw(setup.stage.attendeeId);
    if (!attendee) throw new Error("Expected activated attendee");
    expect(
      (await decryptAttendeeFields(attendee, await getTestPrivateKey(), true))
        .payment_id,
    ).toBe("pi_cs_activate_ok");
  });

  test("activates a nonzero parent and package path", async () => {
    const setup = await activate("cs_activate_path");
    await execute(
      `UPDATE listing_attendees
       SET parent_listing_id = 123, package_group_id = 456
       WHERE attendee_id = ?`,
      [setup.stage.attendeeId],
    );
    setup.input.bookings[0]!.parentListingId = 123;
    setup.input.bookings[0]!.packageGroupId = 456;

    expect(await setup.run()).toEqual({ success: true });
    const row = await execute(
      `SELECT parent_listing_id, package_group_id
       FROM listing_attendees WHERE attendee_id = ?`,
      [setup.stage.attendeeId],
    );
    expect(
      row.rows.map((value) => [
        value.parent_listing_id,
        value.package_group_id,
      ]),
    ).toEqual([[123, 456]]);
  });

  test("activates a parent and child staged together without allocations", async () => {
    const sessionId = "cs_activate_family";
    const parent = await createTestListing({
      maxAttendees: 5,
      name: "Family Parent",
      unitPrice: 1000,
    });
    const child = await createTestListing({
      maxAttendees: 5,
      name: "Family Child",
      unitPrice: 500,
    });
    await listingChildren.setIds(parent.id, [child.id]);
    const stage = await stageCheckout(
      sessionId,
      "stripe",
      checkoutIntent({
        items: [
          checkoutItem({
            listingId: parent.id,
            name: parent.name,
            slug: parent.slug,
          }),
          checkoutItem({
            listingId: child.id,
            name: child.name,
            slug: child.slug,
            unitPrice: 500,
          }),
        ],
      }),
    );
    // Staging stamped the pairing on the stored child row (the child's parent
    // is booked in the same order), even though nothing threaded allocations.
    const staged = await execute(
      `SELECT listing_id, parent_listing_id FROM listing_attendees
        WHERE attendee_id = ? ORDER BY listing_id`,
      [stage.attendeeId],
    );
    expect(
      staged.rows.map((row) => [row.listing_id, row.parent_listing_id]),
    ).toEqual([
      [parent.id, 0],
      [child.id, parent.id],
    ]);
    await reserveSession(sessionId);

    // Activation receives the raw un-stamped bookings (as the payment path
    // builds them) and must derive the same pairing itself — before it did,
    // every parent+child order read as "changed" and was refunded.
    const bookings: OrderBooking[] = [
      {
        date: null,
        durationDays: 1,
        listingId: parent.id,
        pricePaid: 1000,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: child.id,
        pricePaid: 500,
        quantity: 1,
      },
    ];
    const activated = await activateStagedBooking(
      sessionId,
      stage.attendeeId,
      stage.ticketToken,
      {
        address: "",
        bookings,
        email: "buyer@example.com",
        name: "Buyer",
        paymentId: `pi_${sessionId}`,
        phone: "",
        special_instructions: "",
      },
      {
        finalize: { paymentReference: `pi_${sessionId}`, sessionId },
        legs: [],
        usages: [],
      },
    );
    expect(activated).toEqual({ success: true });
    const claimed = await execute(
      `SELECT listing_id, parent_listing_id, quantity FROM listing_attendees
        WHERE attendee_id = ? ORDER BY listing_id`,
      [stage.attendeeId],
    );
    expect(
      claimed.rows.map((row) => [
        row.listing_id,
        row.parent_listing_id,
        row.quantity,
      ]),
    ).toEqual([
      [parent.id, 0, 1],
      [child.id, parent.id, 1],
    ]);
  });

  test("reports a stage whose row is already live without touching it", async () => {
    const setup = await activate("cs_activate_live");
    await execute(
      "UPDATE listing_attendees SET quantity = 1 WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );

    // The row may be a live booking, so activation reports the conflict as a
    // structured outcome (the caller holds the money for the operator) rather
    // than throwing into a webhook retry loop.
    expect(await setup.run()).toEqual({
      reason: "stage_active",
      success: false,
    });
    const row = await execute(
      "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );
    expect(row.rows.map((value) => value.quantity)).toEqual([1]);
  });

  test("reports a stage whose booking paths changed", async () => {
    const setup = await activate("cs_activate_changed");
    await execute(
      "UPDATE listing_attendees SET package_group_id = 999999 WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );

    // Still all quantity 0, so nothing is live: the caller can safely refund.
    expect(await setup.run()).toEqual({
      reason: "stage_mismatch",
      success: false,
    });
  });

  test("leaves the stage at zero when capacity was taken", async () => {
    const sessionId = "cs_activate_full";
    const setup = await setupStage(sessionId, 1);
    const filler = await bookAttendee(setup.listing, {
      email: "filler@example.com",
      name: "Filler",
    });
    if (!filler.success) throw new Error("Expected filler booking");
    await reserveSession(sessionId);

    expect(
      await activateStagedBooking(
        sessionId,
        setup.stage.attendeeId,
        setup.stage.ticketToken,
        setup.input,
        setup.plan,
      ),
    ).toEqual({ reason: "capacity_exceeded", success: false });
  });

  test("reports an extra that sold out", async () => {
    const setup = await activate("cs_activate_extra");
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Last extra",
      stock: 1,
    });
    await execute(
      `INSERT INTO modifier_usages
        (modifier_id, attendee_id, quantity, amount_applied, created)
       VALUES (?, 999999, 1, 100, '2026-07-12T00:00:00.000Z')`,
      [modifier.id],
    );
    setup.plan.usages.push({
      amountApplied: 100,
      modifierId: modifier.id,
      quantity: 1,
    });

    expect(await setup.run()).toEqual({ reason: "sold_out", success: false });
  });

  test("records available extra usage during activation", async () => {
    const setup = await activate("cs_activate_extra_ok");
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Available extra",
      stock: 1,
    });
    setup.plan.usages.push({
      amountApplied: 100,
      modifierId: modifier.id,
      quantity: 1,
    });

    expect(await setup.run()).toEqual({ success: true });
    expect(await modifierUsedQuantities([modifier.id])).toEqual(
      new Map([[modifier.id, 1]]),
    );
  });

  test("fails loudly when attendee encryption is unavailable", async () => {
    const setup = await activate("cs_activate_encryption");
    await execute("DELETE FROM settings WHERE key = ?", [
      CONFIG_KEYS.PUBLIC_KEY,
    ]);
    settings.invalidateCache();

    await expect(setup.run()).rejects.toThrow(
      "Could not encrypt staged attendee",
    );
  });

  test("rolls back when payment finalization is lost", async () => {
    const setup = await activate("cs_activate_finalize");
    await execute(
      `CREATE TRIGGER lose_activation_finalize
       BEFORE UPDATE OF quantity ON listing_attendees
       BEGIN
         DELETE FROM processed_payments
         WHERE payment_session_id = 'cs_activate_finalize';
       END`,
    );

    await expectActivationRollback(
      setup,
      "Payment session cs_activate_finalize was not finalized",
    );
  });

  test("throws when the stage is no longer pending at activation", async () => {
    const setup = await activate("cs_activate_notpending");
    // Resolve the stage out from under the activation (as a concurrent delivery
    // would) while leaving the quantity-0 rows intact: the row-level pre-check
    // still passes, so the guard that matters is the compare-and-set flip, which
    // must find no pending stage to book and refuse to book someone else's.
    await execute(
      "UPDATE checkout_stages SET state = 'failed' WHERE payment_session_id = ?",
      ["cs_activate_notpending"],
    );

    // The throw rolls the whole activation back, so the row stays at quantity 0
    // rather than being claimed against a stage that was already resolved.
    await expectActivationRollback(
      setup,
      "was not this attendee's pending stage at activation",
    );
  });

  // refusalReason is the answer given when the atomic claim refuses. The
  // stage-problem branches model a change that lands WHILE the claim is in
  // flight — after the pre-check passed — so they are driven directly against
  // fabricated row state rather than through activateStagedBooking, whose
  // pre-check would catch the same change first.
  test("refusalReason names a row flipped live during the claim", async () => {
    const setup = await setupStage("cs_refusal_live");
    await execute(
      "UPDATE listing_attendees SET quantity = 1 WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );
    expect(
      await refusalReason(setup.stage.attendeeId, setup.input.bookings, []),
    ).toBe("stage_active");
  });

  test("refusalReason names lines changed during the claim", async () => {
    const setup = await setupStage("cs_refusal_changed");
    const other = await createTestListing({ unitPrice: 1000 });
    const changed = [{ ...setup.input.bookings[0]!, listingId: other.id }];
    expect(await refusalReason(setup.stage.attendeeId, changed, [])).toBe(
      "stage_mismatch",
    );
  });

  test("refusalReason blames capacity when the stage is untouched", async () => {
    const setup = await setupStage("cs_refusal_capacity");
    expect(
      await refusalReason(setup.stage.attendeeId, setup.input.bookings, []),
    ).toBe("capacity_exceeded");
  });

  test("refusalReason throws when the staged rows are gone (impossible state)", async () => {
    const setup = await setupStage("cs_refusal_gone");
    // A staged attendee with zero booking rows can never happen in production:
    // a pending stage's rows are only ever removed with the stage itself, and
    // admin deletes / listing deletes are blocked while pending. If it is ever
    // observed it is a missed cascade, so it must throw, not book fresh around.
    await execute("DELETE FROM listing_attendees WHERE attendee_id = ?", [
      setup.stage.attendeeId,
    ]);
    await expect(
      refusalReason(setup.stage.attendeeId, setup.input.bookings, []),
    ).rejects.toThrow("has no booking rows at activation");
  });
});
