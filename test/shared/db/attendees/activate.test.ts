import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { OrderBooking } from "#shared/booking-lines.ts";
import { activateStagedBooking } from "#shared/db/attendees/activate.ts";
import type { FinalizedBookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
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

  test("rejects a stage whose row is already live", async () => {
    const setup = await activate("cs_activate_live");
    await execute(
      "UPDATE listing_attendees SET quantity = 1 WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );

    await expect(setup.run()).rejects.toThrow(
      `Checkout stage ${setup.stage.attendeeId} is already active`,
    );
  });

  test("rejects a stage whose booking paths changed", async () => {
    const setup = await activate("cs_activate_changed");
    await execute(
      "UPDATE listing_attendees SET package_group_id = 999999 WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );

    await expect(setup.run()).rejects.toThrow(
      `Checkout stage ${setup.stage.attendeeId} booking lines changed`,
    );
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

    expect(await setup.run()).toEqual({ reason: "sold-out", success: false });
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

    await expect(setup.run()).rejects.toThrow(
      "Payment session cs_activate_finalize was not finalized",
    );
    const row = await execute(
      "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
      [setup.stage.attendeeId],
    );
    expect(row.rows.map((value) => value.quantity)).toEqual([0]);
  });
});
