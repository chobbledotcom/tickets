/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import {
  beginCheckoutStageRefund,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { testCheckoutRefund } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  activationBooking,
  setupActivationStage,
  storedActivationRows,
} from "./activate-staged.helpers.ts";

/* jscpd:ignore-end */

const activateStagedAttendee = attendeesApi.activateStagedAttendee;

describeWithEnv(
  "db > staged attendee activation refusals",
  { db: true },
  () => {
    test("returns a structured mismatch without changing staged rows", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_mismatch", [
        activationBooking(listing.id),
      ]);
      setup.input.bookings[0]!.packageGroupId = 99;

      expect(
        await activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).toEqual({ reason: "stage_mismatch", success: false });
      expect(
        (await storedActivationRows(setup.stage.attendeeId))[0]!.quantity,
      ).toBe(0);
    });

    test("returns a structured capacity refusal", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      const first = await setupActivationStage("activate_capacity_first", [
        activationBooking(listing.id),
      ]);
      const second = await setupActivationStage("activate_capacity_second", [
        activationBooking(listing.id),
      ]);
      expect(
        await activateStagedAttendee(first.stage, first.input, first.plan),
      ).toEqual({ success: true });

      expect(
        await activateStagedAttendee(second.stage, second.input, second.plan),
      ).toEqual({ reason: "capacity_exceeded", success: false });
    });

    test("returns a structured modifier stock refusal", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_stock", [
        activationBooking(listing.id),
      ]);
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 100,
        direction: "charge",
        name: "Gone extra",
        stock: 0,
      });
      setup.plan.usages.push({
        amountApplied: 100,
        modifierId: modifier.id,
        quantity: 1,
      });

      expect(
        await activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).toEqual({ reason: "sold_out", success: false });
    });

    test("serializes concurrent claims for the last seat", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      const first = await setupActivationStage("activate_race_first", [
        activationBooking(listing.id),
      ]);
      const second = await setupActivationStage("activate_race_second", [
        activationBooking(listing.id),
      ]);

      const results = await Promise.all([
        activateStagedAttendee(first.stage, first.input, first.plan),
        activateStagedAttendee(second.stage, second.input, second.plan),
      ]);
      expect(results).toContainEqual({ success: true });
      expect(results).toContainEqual({
        reason: "capacity_exceeded",
        success: false,
      });
      const total = await getDb().execute(
        "SELECT booked_quantity FROM listings WHERE id = ?",
        [listing.id],
      );
      expect(total.rows[0]!.booked_quantity).toBe(1);
    });

    test("throws and rolls back when the payment claim disappears during activation", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_finalize_loss", [
        activationBooking(listing.id),
      ]);
      await getDb().execute(`CREATE TRIGGER lose_staged_finalize
      BEFORE UPDATE OF quantity ON listing_attendees BEGIN
        DELETE FROM processed_payments WHERE payment_session_id = 'activate_finalize_loss';
      END`);

      await expect(
        activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).rejects.toThrow(
        "Payment session activate_finalize_loss was not finalized",
      );
      expect(
        (await storedActivationRows(setup.stage.attendeeId))[0]!.quantity,
      ).toBe(0);
      expect(
        await loadCheckoutStageByPaymentSession("activate_finalize_loss"),
      ).not.toBeNull();
    });

    test("throws for a missing stage or unresolved payment claim", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_missing_claim", [
        activationBooking(listing.id),
      ]);
      await getDb().execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        ["activate_missing_claim"],
      );

      await expect(
        activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).rejects.toThrow(
        "Payment session activate_missing_claim was not claimed",
      );
      await expect(
        beginCheckoutStageRefund("missing-stage", testCheckoutRefund()),
      ).rejects.toThrow("Checkout stage missing-stage did not enter refunding");
    });

    test("throws and rolls back when the stage is already refunding", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_refunding", [
        activationBooking(listing.id),
      ]);
      await beginCheckoutStageRefund(
        "activate_refunding",
        testCheckoutRefund(),
      );

      await expect(
        activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).rejects.toThrow("was not pending");
      expect(
        (await storedActivationRows(setup.stage.attendeeId))[0]!.quantity,
      ).toBe(0);
    });

    test("returns capacity refusal for negative demand or a deleted listing", async () => {
      const listing = await createTestListing();
      const negative = await setupActivationStage("activate_negative", [
        activationBooking(listing.id),
      ]);
      negative.input.bookings[0]!.quantity = -1;
      expect(
        await activateStagedAttendee(
          negative.stage,
          negative.input,
          negative.plan,
        ),
      ).toEqual({ reason: "capacity_exceeded", success: false });

      const missing = await setupActivationStage("activate_deleted", [
        activationBooking(listing.id),
      ]);
      await getDb().execute("DELETE FROM listings WHERE id = ?", [listing.id]);
      expect(
        await activateStagedAttendee(
          missing.stage,
          missing.input,
          missing.plan,
        ),
      ).toEqual({ reason: "capacity_exceeded", success: false });
    });

    test("propagates an unexpected write failure and rolls back", async () => {
      const listing = await createTestListing();
      const setup = await setupActivationStage("activate_write_failure", [
        activationBooking(listing.id),
      ]);
      await getDb().execute(`CREATE TRIGGER reject_staged_activation
      BEFORE UPDATE OF quantity ON listing_attendees BEGIN
        SELECT RAISE(ABORT, 'activation write failed');
      END`);

      await expect(
        activateStagedAttendee(setup.stage, setup.input, setup.plan),
      ).rejects.toThrow("activation write failed");
      expect(
        (await storedActivationRows(setup.stage.attendeeId))[0]!.quantity,
      ).toBe(0);
    });
  },
);
