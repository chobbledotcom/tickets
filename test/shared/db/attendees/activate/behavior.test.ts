import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { activateStagedAttendeeImpl } from "#shared/db/attendees/activate.ts";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  activationBooking,
  setupActivationStage,
} from "../activate-staged.helpers.ts";

describeWithEnv("staged activation edge behavior", { db: true }, () => {
  test("matches the same three staged lines in a different input order", async () => {
    const listings = [
      await createTestListing(),
      await createTestListing(),
      await createTestListing(),
    ];
    const setup = await setupActivationStage(
      "activate_reordered",
      listings.map((listing) => activationBooking(listing.id)),
    );
    setup.input.bookings = [
      setup.input.bookings[1]!,
      setup.input.bookings[0]!,
      setup.input.bookings[2]!,
    ];

    expect(
      await activateStagedAttendeeImpl(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
  });

  test("allows a zero-quantity staged line", async () => {
    const listing = await createTestListing();
    const setup = await setupActivationStage("activate_zero", [
      activationBooking(listing.id, { quantity: 0 }),
    ]);

    expect(
      await activateStagedAttendeeImpl(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
  });

  test("enforces combined demand against a shared group cap", async () => {
    const group = await createTestGroup({ maxAttendees: 1 });
    const first = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
    });
    const second = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
    });
    const setup = await setupActivationStage("activate_group_capacity", [
      activationBooking(first.id),
      activationBooking(second.id),
    ]);

    expect(
      await activateStagedAttendeeImpl(setup.stage, setup.input, setup.plan),
    ).toEqual({ reason: "capacity_exceeded", success: false });
  });

  test("remaps both attendee sides to the staged attendee", async () => {
    const listing = await createTestListing();
    const setup = await setupActivationStage("activate_remap", [
      activationBooking(listing.id),
    ]);
    setup.plan.legs = [
      {
        amount: 100,
        destination: attendeeAccount(999),
        eventGroup: "activation-remap",
        occurredAt: "2030-01-01T00:00:00.000Z",
        reference: "activation-remap-in",
        source: WORLD,
      },
      {
        amount: 100,
        destination: WORLD,
        eventGroup: "activation-remap",
        occurredAt: "2030-01-01T00:00:00.000Z",
        reference: "activation-remap-out",
        source: attendeeAccount(999),
      },
    ];

    expect(
      await activateStagedAttendeeImpl(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
    const rows = await getDb().execute({
      args: ["activation-remap"],
      sql: `SELECT source_id, dest_id FROM transfers
             WHERE event_group = ? ORDER BY reference`,
    });
    expect(rows.rows).toEqual([
      { dest_id: String(setup.stage.attendeeId), source_id: "world" },
      { dest_id: "world", source_id: String(setup.stage.attendeeId) },
    ]);
  });

  test("posts and stamps a one-leg activation", async () => {
    const listing = await createTestListing();
    const setup = await setupActivationStage("activate_one_leg", [
      activationBooking(listing.id),
    ]);
    setup.plan.legs = [
      {
        amount: 100,
        destination: attendeeAccount(999),
        eventGroup: "activation-one-leg",
        occurredAt: "2030-01-01T00:00:00.000Z",
        reference: "activation-one-leg",
        source: WORLD,
      },
    ];

    expect(
      await activateStagedAttendeeImpl(setup.stage, setup.input, setup.plan),
    ).toEqual({ success: true });
    const row = await getDb().execute({
      args: [setup.stage.attendeeId],
      sql: `SELECT ledger_event_group FROM listing_attendees
             WHERE attendee_id = ?`,
    });
    expect(row.rows[0]!.ledger_event_group).toBe("activation-one-leg");
  });
});
