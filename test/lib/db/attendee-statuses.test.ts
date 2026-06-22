import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  assignNextAttendeeStatusSortOrder,
  attendeeStatusesTable,
  DEFAULT_ATTENDEE_STATUS_NAME,
  ensureDefaultAttendeeStatus,
  getAllAttendeeStatuses,
  getAttendeeStatus,
  getPaidDefaultStatus,
  getPublicDefaultStatus,
  getPublicStatusId,
  invalidateAttendeeStatusesCache,
  swapAttendeeStatusOrder,
} from "#shared/db/attendee-statuses.ts";
import { createAttendeeAtomic, getAttendee } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("db > attendee statuses", { db: true }, () => {
  test("the migration seeds a single non-reservation default status", async () => {
    const statuses = await getAllAttendeeStatuses();
    expect(statuses).toHaveLength(1);
    const seed = statuses[0]!;
    expect(seed.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
    expect(seed.is_public_default).toBe(true);
    expect(seed.is_paid_default).toBe(true);
    expect(seed.is_reservation).toBe(false);
    expect(seed.reservation_amount).toBe("0");
    expect(seed.sort_order).toBe(0);
  });

  test("getPublicDefaultStatus and getPaidDefaultStatus return the seed", async () => {
    const [pub, paid] = await Promise.all([
      getPublicDefaultStatus(),
      getPaidDefaultStatus(),
    ]);
    expect(pub?.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
    expect(paid?.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
  });

  test("getAttendeeStatus returns by id and null when missing", async () => {
    const [seed] = await getAllAttendeeStatuses();
    expect((await getAttendeeStatus(seed!.id))?.name).toBe(
      DEFAULT_ATTENDEE_STATUS_NAME,
    );
    expect(await getAttendeeStatus(9999)).toBeNull();
  });

  test("getPublicStatusId returns the default id, or null when none is set", async () => {
    const [seed] = await getAllAttendeeStatuses();
    expect(await getPublicStatusId()).toBe(seed!.id);
    await getDb().execute("UPDATE attendee_statuses SET is_public_default = 0");
    invalidateAttendeeStatusesCache();
    expect(await getPublicStatusId()).toBeNull();
  });

  test("ensureDefaultAttendeeStatus is idempotent once a status exists", async () => {
    await ensureDefaultAttendeeStatus();
    expect(await getAllAttendeeStatuses()).toHaveLength(1);
  });

  test("inserting statuses returns them ordered by sort_order then id", async () => {
    const reserved = await attendeeStatusesTable.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
      sortOrder: 2,
    });
    await attendeeStatusesTable.insert({ name: "Waitlist", sortOrder: 1 });

    const names = (await getAllAttendeeStatuses()).map((s) => s.name);
    // seed (0), Waitlist (1), Reserved (2)
    expect(names).toEqual([
      DEFAULT_ATTENDEE_STATUS_NAME,
      "Waitlist",
      "Reserved",
    ]);
    expect(reserved.is_reservation).toBe(true);
    expect(reserved.reservation_amount).toBe("10%");
  });

  test("assignNextAttendeeStatusSortOrder assigns max + 1", async () => {
    const created = await attendeeStatusesTable.insert({ name: "New" });
    await assignNextAttendeeStatusSortOrder(created.id);
    const updated = await getAttendeeStatus(created.id);
    // Seed is sort_order 0, so the next value is 1.
    expect(updated?.sort_order).toBe(1);
  });

  test("swapAttendeeStatusOrder swaps two statuses' sort_order", async () => {
    const a = await attendeeStatusesTable.insert({ name: "A", sortOrder: 5 });
    const b = await attendeeStatusesTable.insert({ name: "B", sortOrder: 6 });
    await swapAttendeeStatusOrder(a.id, b.id);
    expect((await getAttendeeStatus(a.id))?.sort_order).toBe(6);
    expect((await getAttendeeStatus(b.id))?.sort_order).toBe(5);
  });

  test("update changes fields and invalidates the cache", async () => {
    const created = await attendeeStatusesTable.insert({ name: "Pending" });
    await attendeeStatusesTable.update(created.id, {
      isReservation: true,
      reservationAmount: "25",
    });
    const updated = await getAttendeeStatus(created.id);
    expect(updated?.is_reservation).toBe(true);
    expect(updated?.reservation_amount).toBe("25");
  });

  test("deleteById removes a status", async () => {
    const created = await attendeeStatusesTable.insert({ name: "Temp" });
    await attendeeStatusesTable.deleteById(created.id);
    expect(await getAttendeeStatus(created.id)).toBeNull();
  });

  test("status name is encrypted at rest", async () => {
    const created = await attendeeStatusesTable.insert({ name: "VIP Guest" });
    const raw = await getDb().execute({
      args: [created.id],
      sql: "SELECT name FROM attendee_statuses WHERE id = ?",
    });
    // Stored value is ciphertext, not the plaintext name.
    expect(String(raw.rows[0]!.name)).not.toBe("VIP Guest");
    // ...but it decrypts back to the plaintext name on read.
    expect((await getAttendeeStatus(created.id))?.name).toBe("VIP Guest");
  });

  test("ensureDefaultAttendeeStatus seeds and backfills null-status attendees", async () => {
    // Wipe the seed and insert an attendee with no status.
    await getDb().execute("DELETE FROM attendee_statuses");
    invalidateAttendeeStatusesCache();
    await getDb().execute({
      args: [],
      sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES ('2024-01-01T00:00:00Z', '', NULL)",
    });
    const { rows } = await getDb().execute(
      "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
    );
    const attendeeId = Number(rows[0]!.id);

    await ensureDefaultAttendeeStatus();

    const statuses = await getAllAttendeeStatuses();
    expect(statuses).toHaveLength(1);
    const backfilled = await getDb().execute({
      args: [attendeeId],
      sql: "SELECT status_id FROM attendees WHERE id = ?",
    });
    expect(Number(backfilled.rows[0]!.status_id)).toBe(statuses[0]!.id);
  });

  test("createAttendeeAtomic persists status_id and remaining_balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const status = await getPublicDefaultStatus();
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 500, quantity: 1 }],
      email: "guest@example.com",
      name: "Guest",
      remainingBalance: 1500,
      statusId: status!.id,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");

    // Outstanding balance projects from the ledger now: post the booking's gross
    // sale (£20 = £5 deposit + £15 owed) and the £5 deposit, so balanceOf nets to
    // −1500 and remaining_balance reads 1500.
    await postListingSale({
      amountPaid: 500,
      attendeeId: result.attendees[0]!.id,
      gross: 2000,
      listingId: listing.id,
    });
    const stored = await getAttendee(
      result.attendees[0]!.id,
      await getTestPrivateKey(),
    );
    expect(stored?.status_id).toBe(status!.id);
    expect(stored?.remaining_balance).toBe(1500);
  });
});
