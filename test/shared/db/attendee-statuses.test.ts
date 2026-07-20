import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type AttendeeStatusWriteInput,
  attendeeStatuses,
  attendeeStatusOrder,
  attendeeStatusWrites,
  DEFAULT_ATTENDEE_STATUS_NAME,
  ensureDefaultAttendeeStatus,
  getAttendeeStatus,
  requirePaidDefaultStatus,
  requirePublicDefaultStatus,
  requirePublicStatusId,
} from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { updateAttendeeStatus } from "#shared/db/attendees/update.ts";
import { getDb } from "#shared/db/client.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

const statusInput = (
  name: string,
  defaults: Partial<AttendeeStatusWriteInput> = {},
): AttendeeStatusWriteInput => ({
  isPaidDefault: false,
  isPublicDefault: false,
  isReservation: false,
  name,
  reservationAmount: "0",
  ...defaults,
});

const createAttendeeWithStatus = async (statusId: number): Promise<number> => {
  const attendee = await getDb().execute({
    args: [new Date().toISOString(), statusId],
    sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
  });
  return Number(attendee.lastInsertRowid);
};

const storedAttendeeStatus = async (attendeeId: number): Promise<number> => {
  const stored = await getDb().execute({
    args: [attendeeId],
    sql: "SELECT attendee.status_id FROM attendees AS attendee WHERE attendee.id = ?",
  });
  return Number(stored.rows[0]!.status_id);
};

const setUpAssignmentRace = async (): Promise<{
  attendeeId: number;
  seedId: number;
  spareId: number;
}> => {
  const seed = (await attendeeStatuses.getAll())[0]!;
  const spare = await attendeeStatuses.table.insert({ name: "Spare" });
  return {
    attendeeId: await createAttendeeWithStatus(seed.id),
    seedId: seed.id,
    spareId: spare.id,
  };
};

describeWithEnv("db > attendee statuses", { db: true }, () => {
  test("the migration seeds a single non-reservation default status", async () => {
    const statuses = await attendeeStatuses.getAll();
    expect(statuses).toHaveLength(1);
    const seed = statuses[0]!;
    expect(seed.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
    expect(seed.is_public_default).toBe(true);
    expect(seed.is_paid_default).toBe(true);
    expect(seed.is_reservation).toBe(false);
    expect(seed.reservation_amount).toBe("0");
    expect(seed.sort_order).toBe(0);
  });

  test("required default status lookups return the seed", async () => {
    const [pub, paid] = await Promise.all([
      requirePublicDefaultStatus(),
      requirePaidDefaultStatus(),
    ]);
    expect(pub?.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
    expect(paid?.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
  });

  test("getAttendeeStatus returns by id and null when missing", async () => {
    const [seed] = await attendeeStatuses.getAll();
    expect((await getAttendeeStatus(seed!.id))?.name).toBe(
      DEFAULT_ATTENDEE_STATUS_NAME,
    );
    expect(await getAttendeeStatus(9999)).toBeNull();
  });

  test("requirePublicStatusId throws when the required default is missing", async () => {
    const [seed] = await attendeeStatuses.getAll();
    expect(await requirePublicStatusId()).toBe(seed!.id);
    await getDb().execute("UPDATE attendee_statuses SET is_public_default = 0");
    attendeeStatuses.invalidate();
    await expect(requirePublicStatusId()).rejects.toThrow(
      "No attendee status has the required is_public_default flag",
    );
  });

  test("ensureDefaultAttendeeStatus is idempotent once a status exists", async () => {
    await ensureDefaultAttendeeStatus();
    expect(await attendeeStatuses.getAll()).toHaveLength(1);
  });

  test("inserting statuses returns them ordered by sort_order then id", async () => {
    const reserved = await attendeeStatuses.table.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
      sortOrder: 2,
    });
    const waitlist = await attendeeStatuses.table.insert({
      name: "Waitlist",
      sortOrder: 1,
    });

    const names = (await attendeeStatuses.getAll()).map((s) => s.name);
    // seed (0), Waitlist (1), Reserved (2)
    expect(names).toEqual([
      DEFAULT_ATTENDEE_STATUS_NAME,
      "Waitlist",
      "Reserved",
    ]);
    expect(reserved.is_reservation).toBe(true);
    expect(reserved.reservation_amount).toBe("10%");
    const storedWaitlist = await getAttendeeStatus(waitlist.id);
    expect(storedWaitlist?.is_paid_default).toBe(false);
    expect(storedWaitlist?.is_public_default).toBe(false);
    expect(storedWaitlist?.is_reservation).toBe(false);
  });

  test("ordered rows swap two statuses' sort_order", async () => {
    const a = await attendeeStatuses.table.insert({ name: "A", sortOrder: 5 });
    const b = await attendeeStatuses.table.insert({ name: "B", sortOrder: 6 });
    await attendeeStatusOrder.swap({ first: a.id, second: b.id });
    expect((await getAttendeeStatus(a.id))?.sort_order).toBe(6);
    expect((await getAttendeeStatus(b.id))?.sort_order).toBe(5);
  });

  test("update changes fields and invalidates the cache", async () => {
    const created = await attendeeStatuses.table.insert({ name: "Pending" });
    await attendeeStatuses.table.update(created.id, {
      isReservation: true,
      reservationAmount: "25",
    });
    const updated = await getAttendeeStatus(created.id);
    expect(updated?.is_reservation).toBe(true);
    expect(updated?.reservation_amount).toBe("25");
  });

  test("deleteById removes a status", async () => {
    const created = await attendeeStatuses.table.insert({ name: "Temp" });
    await attendeeStatuses.table.deleteById(created.id);
    expect(await getAttendeeStatus(created.id)).toBeNull();
  });

  test("status name is encrypted at rest", async () => {
    const created = await attendeeStatuses.table.insert({ name: "VIP Guest" });
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
    attendeeStatuses.invalidate();
    await getDb().execute({
      args: [],
      sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES ('2024-01-01T00:00:00Z', '', NULL)",
    });
    const { rows } = await getDb().execute(
      "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
    );
    const attendeeId = Number(rows[0]!.id);

    await ensureDefaultAttendeeStatus();

    const statuses = await attendeeStatuses.getAll();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      is_paid_default: true,
      is_public_default: true,
      is_reservation: false,
      name: DEFAULT_ATTENDEE_STATUS_NAME,
      reservation_amount: "0",
      sort_order: 0,
    });
    const backfilled = await getDb().execute({
      args: [attendeeId],
      sql: "SELECT status_id FROM attendees WHERE id = ?",
    });
    expect(Number(backfilled.rows[0]!.status_id)).toBe(statuses[0]!.id);
  });

  test("concurrent default changes leave one public and paid default", async () => {
    const first = await attendeeStatuses.table.insert({ name: "First" });
    const second = await attendeeStatuses.table.insert({ name: "Second" });

    const results = await Promise.all([
      attendeeStatusWrites.save(
        first.id,
        statusInput("First", {
          isPaidDefault: true,
          isPublicDefault: true,
        }),
      ),
      attendeeStatusWrites.save(
        second.id,
        statusInput("Second", {
          isPaidDefault: true,
          isPublicDefault: true,
        }),
      ),
    ]);
    expect(results).toEqual([
      {
        ok: true,
        value: {
          id: first.id,
          is_paid_default: true,
          is_public_default: true,
          is_reservation: false,
          name: "First",
          reservation_amount: "0",
          sort_order: 0,
        },
      },
      {
        ok: true,
        value: {
          id: second.id,
          is_paid_default: true,
          is_public_default: true,
          is_reservation: false,
          name: "Second",
          reservation_amount: "0",
          sort_order: 0,
        },
      },
    ]);

    const defaults = await getDb().execute(
      `SELECT status.is_public_default, status.is_paid_default
         FROM attendee_statuses AS status
        WHERE status.is_public_default = 1 OR status.is_paid_default = 1`,
    );
    expect(
      defaults.rows.filter((status) => status.is_public_default === 1),
    ).toHaveLength(1);
    expect(
      defaults.rows.filter((status) => status.is_paid_default === 1),
    ).toHaveLength(1);
  });

  test("a failed default change restores the previous defaults", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;
    const candidate = await attendeeStatuses.table.insert({
      name: "Candidate",
    });
    await getDb().execute(
      `CREATE TRIGGER fail_candidate_status_update
       BEFORE UPDATE ON attendee_statuses
       WHEN NEW.id = ${candidate.id}
       BEGIN
         SELECT RAISE(ABORT, 'candidate update failed');
       END`,
    );

    await expect(
      attendeeStatusWrites.save(
        candidate.id,
        statusInput("Candidate", {
          isPaidDefault: true,
          isPublicDefault: true,
        }),
      ),
    ).rejects.toThrow("candidate update failed");

    const defaults = await getDb().execute(
      `SELECT status.id, status.is_public_default, status.is_paid_default
         FROM attendee_statuses AS status
        ORDER BY status.id`,
    );
    expect(defaults.rows).toEqual([
      { id: seed.id, is_paid_default: 1, is_public_default: 1 },
      { id: candidate.id, is_paid_default: 0, is_public_default: 0 },
    ]);
  });

  test("a stale edit cannot clear a newly selected default", async () => {
    const candidate = await attendeeStatuses.table.insert({
      name: "Candidate",
    });

    const promoted = attendeeStatusWrites.save(
      candidate.id,
      statusInput("Candidate", { isPublicDefault: true }),
    );
    const staleEdit = attendeeStatusWrites.save(
      candidate.id,
      statusInput("Candidate"),
    );

    expect(await promoted).toEqual({
      ok: true,
      value: {
        id: candidate.id,
        is_paid_default: false,
        is_public_default: true,
        is_reservation: false,
        name: "Candidate",
        reservation_amount: "0",
        sort_order: 0,
      },
    });
    expect(await staleEdit).toEqual({
      error: "public_default_required",
      ok: false,
    });
    expect((await requirePublicDefaultStatus()).id).toBe(candidate.id);
  });

  test("status writes fail loudly for a missing status", async () => {
    await expect(
      attendeeStatusWrites.save(99_999, statusInput("Missing")),
    ).rejects.toThrow("Attendee status 99999 does not exist");
    await expect(attendeeStatusWrites.delete(99_999)).rejects.toThrow(
      "Attendee status 99999 does not exist",
    );
  });

  test("attendee creation rejects a missing status", async () => {
    await expect(
      getDb().execute({
        args: [new Date().toISOString(), 99_999],
        sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
      }),
    ).rejects.toThrow("attendee status does not exist");
  });

  test("concurrent deletion attempts keep the last status", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;
    const spare = await attendeeStatuses.table.insert({ name: "Spare" });
    await getDb().execute(
      "UPDATE attendee_statuses AS status SET is_public_default = 0, is_paid_default = 0",
    );

    const results = await Promise.all([
      attendeeStatusWrites.delete(seed.id),
      attendeeStatusWrites.delete(spare.id),
    ]);

    expect(results).toEqual([
      { ok: true, value: undefined },
      { error: "last_status", ok: false },
    ]);
    const remaining = await getDb().execute(
      "SELECT status.id FROM attendee_statuses AS status",
    );
    expect(remaining.rows).toEqual([{ id: spare.id }]);
  });

  test("an attendee assignment queued after deletion cannot use the deleted status", async () => {
    const { attendeeId, seedId, spareId } = await setUpAssignmentRace();

    const deletion = attendeeStatusWrites.delete(spareId);
    const assignment = updateAttendeeStatus(attendeeId, spareId);

    expect(await deletion).toEqual({ ok: true, value: undefined });
    await expect(assignment).rejects.toThrow("attendee status does not exist");
    expect(await storedAttendeeStatus(attendeeId)).toBe(seedId);
  });

  test("an attendee assignment queued before deletion makes the status in use", async () => {
    const { attendeeId, spareId } = await setUpAssignmentRace();

    const assignment = updateAttendeeStatus(attendeeId, spareId);
    const deletion = attendeeStatusWrites.delete(spareId);

    await assignment;
    expect(await deletion).toEqual({ error: "status_in_use", ok: false });
    expect(await storedAttendeeStatus(attendeeId)).toBe(spareId);
  });

  test("createAttendeeAtomic persists status_id and remaining_balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const status = await requirePublicDefaultStatus();
    const result = await attendeesApi.createAttendeeAtomic({
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
    const stored = await getAttendeeOrNull(
      result.attendees[0]!.id,
      await getTestPrivateKey(),
    );
    expect(stored?.status_id).toBe(status!.id);
    expect(stored?.remaining_balance).toBe(1500);
  });
});
