/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import {
  beginCheckoutStageRefund,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { getVisits, hashEmail } from "#shared/db/contact-preferences.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { testCheckoutRefund } from "#test-utils/checkout-stages.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  activationBooking,
  setupActivationStage,
  stagedContact,
  storedActivationRows,
} from "./activate-staged.helpers.ts";

/* jscpd:ignore-end */

const activateStagedAttendee = attendeesApi.activateStagedAttendee;

describeWithEnv("db > staged attendee activation", { db: true }, () => {
  test("loads a pending or refunding stage by session with its exact token", async () => {
    const listing = await createTestListing();
    const setup = await setupActivationStage("stage_lookup", [
      activationBooking(listing.id),
    ]);
    expect(setup.stage).toMatchObject({
      paymentSessionId: "stage_lookup",
      state: "pending",
      ticketToken: "ticket-stage_lookup",
    });

    await beginCheckoutStageRefund("stage_lookup", testCheckoutRefund());

    expect(
      await loadCheckoutStageByPaymentSession("stage_lookup"),
    ).toMatchObject({
      state: "refunding",
      ticketToken: "ticket-stage_lookup",
    });
  });

  test("activates exact single, multi, package, parent, and dated rows in place", async () => {
    const group = await createTestGroup({ maxAttendees: 5 });
    const plain = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
    });
    const dated = await createDailyTestListing({ maxAttendees: 5 });
    const setup = await setupActivationStage("activate_exact", [
      activationBooking(plain.id, {
        packageGroupId: 41,
        parentListingId: 17,
        quantity: 2,
      }),
      activationBooking(dated.id, {
        date: "2026-08-04",
        durationDays: 2,
        quantity: 1,
      }),
    ]);

    expect(
      await activateStagedAttendee(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
    expect(
      (await storedActivationRows(setup.stage.attendeeId)).map((row) => [
        row.listing_id,
        row.start_at,
        row.end_at,
        row.quantity,
        row.parent_listing_id,
        row.package_group_id,
      ]),
    ).toEqual([
      [plain.id, null, null, 2, 17, 41],
      [dated.id, "2026-08-04T00:00:00Z", "2026-08-06T00:00:00.000Z", 1, 0, 0],
    ]);
  });

  test("keeps the attendee identity, persists payment details, and deletes the stage", async () => {
    const listing = await createTestListing();
    const freeBooking = activationBooking(listing.id);
    delete freeBooking.pricePaid;
    const setup = await setupActivationStage("activate_identity", [
      freeBooking,
    ]);

    expect(
      await activateStagedAttendee(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
    expect(
      await loadCheckoutStageByPaymentSession("activate_identity"),
    ).toBeNull();
    const raw = await getAttendeeRaw(setup.stage.attendeeId);
    if (!raw) throw new Error("Expected activated attendee");
    const attendee = await decryptAttendeeFields(
      raw,
      await getTestPrivateKey(),
    );
    expect({
      id: attendee.id,
      paymentId: attendee.payment_id,
      token: attendee.ticket_token,
    }).toEqual({
      id: setup.stage.attendeeId,
      paymentId: "payment-activate_identity",
      token: "ticket-activate_identity",
    });
  });

  test("persists modifier, ledger, contact activity, and payment finalization", async () => {
    const listing = await createTestListing();
    const setup = await setupActivationStage("activate_effects", [
      activationBooking(listing.id),
    ]);
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 100,
      direction: "charge",
      name: "Limited extra",
      stock: 1,
    });
    setup.plan.usages.push({
      amountApplied: 100,
      modifierId: modifier.id,
      quantity: 1,
    });
    setup.plan.legs.push(
      {
        amount: 1000,
        destination: attendeeAccount(setup.stage.attendeeId),
        eventGroup: "activation-effects",
        occurredAt: "2026-08-01T12:00:00.000Z",
        reference: "activation-effects-sale",
        source: WORLD,
      },
      {
        amount: 1000,
        destination: WORLD,
        eventGroup: "activation-effects",
        occurredAt: "2026-08-01T12:00:00.000Z",
        reference: "activation-effects-payment",
        source: attendeeAccount(setup.stage.attendeeId),
      },
    );

    expect(
      await activateStagedAttendee(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
    expect(await modifierUsedQuantities([modifier.id])).toEqual(
      new Map([[modifier.id, 1]]),
    );
    expect(await getVisits(await hashEmail(stagedContact.email))).toBe(1);
    const stored = await getDb().execute({
      args: ["activation-effects", "activate_effects"],
      sql: `SELECT payment.attendee_id, transfer.event_group
              FROM processed_payments AS payment
              JOIN transfers AS transfer ON transfer.event_group = ?
             WHERE payment.payment_session_id = ?`,
    });
    expect(stored.rows).toEqual([
      {
        attendee_id: setup.stage.attendeeId,
        event_group: "activation-effects",
      },
      {
        attendee_id: setup.stage.attendeeId,
        event_group: "activation-effects",
      },
    ]);
    expect(
      (await storedActivationRows(setup.stage.attendeeId))[0]!
        .ledger_event_group,
    ).toBe("activation-effects");
  });
});
