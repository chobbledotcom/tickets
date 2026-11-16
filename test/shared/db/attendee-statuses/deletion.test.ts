import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type AttendeeStatus,
  attendeeStatuses,
  attendeeStatusWrites,
  getAttendeeStatus,
} from "#db/attendee-statuses.ts";
import { getDb, withTransaction } from "#db/client.ts";
import { insertRow } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { update } from "#db/write.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const createAttendeeWithStatus = async (statusId: number): Promise<number> => {
  const attendee = await getDb().execute(
    sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES (${new Date().toISOString()}, '', ${statusId})`,
  );
  return Number(attendee.lastInsertRowid);
};

const storedAttendeeStatus = async (attendeeId: number): Promise<number> => {
  const stored = await getDb().execute(
    sql`SELECT attendee.status_id FROM attendees AS attendee WHERE attendee.id = ${attendeeId}`,
  );
  return Number(stored.rows[0]!.status_id);
};

/** Clears every default flag, so a deletion falls back to a status only when a
 * test names one. */
const clearStatusDefaults = async (): Promise<void> => {
  await getDb().execute(
    sql`UPDATE attendee_statuses AS status SET is_public_default = 0, is_paid_default = 0`,
  );
};

/** The first seeded status, kept flagless as a bystander. */
const seedStatus = async (): Promise<AttendeeStatus> => {
  const seed = (await attendeeStatuses.getAll())[0]!;
  await clearStatusDefaults();
  return seed;
};

/** Adds a status that carries no default flag. */
const addStatus = async (name: string): Promise<AttendeeStatus> => {
  const status = await insertRow(tables.attendee_statuses, { name });
  await clearStatusDefaults();
  return status;
};

const setUpAssignmentRace = async (): Promise<{
  attendeeId: number;
  seedId: number;
  spareId: number;
}> => {
  const seed = (await attendeeStatuses.getAll())[0]!;
  const spare = await insertRow(tables.attendee_statuses, { name: "Spare" });
  return {
    attendeeId: await createAttendeeWithStatus(seed.id),
    seedId: seed.id,
    spareId: spare.id,
  };
};

/** The status write the admin save runs inside the atomic edit's transaction,
 * so the race below exercises the statement shape production uses. */
const assignStatus = (attendeeId: number, statusId: number): Promise<void> =>
  withTransaction(async (tx) => {
    await tx.execute(
      update(tables.attendees, { status_id: statusId }).where({
        id: attendeeId,
      }),
    );
  });

describeWithEnv("db > attendee status deletion", { db: true }, () => {
  test("status writes fail loudly for a missing status", async () => {
    await expect(
      attendeeStatusWrites.save(99_999, {
        isPaidDefault: false,
        isPublicDefault: false,
        isReservation: false,
        name: "Missing",
        reservationAmount: "0",
      }),
    ).rejects.toThrow("Attendee status 99999 does not exist");
    await expect(attendeeStatusWrites.delete(99_999)).rejects.toThrow(
      "Attendee status 99999 does not exist",
    );
  });

  test("attendee creation rejects a missing status", async () => {
    await expect(
      getDb().execute(
        sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES (${new Date().toISOString()}, '', ${99_999})`,
      ),
    ).rejects.toThrow("attendee status does not exist");
  });

  test("concurrent deletion attempts keep the last status", async () => {
    const seed = await seedStatus();
    const spare = await addStatus("Spare");

    const results = await Promise.all([
      attendeeStatusWrites.delete(seed.id),
      attendeeStatusWrites.delete(spare.id),
    ]);

    expect(results).toEqual([
      { ok: true, value: undefined },
      { error: "last_status", ok: false },
    ]);
    const remaining = await getDb().execute(
      sql`SELECT status.id FROM attendee_statuses AS status`,
    );
    expect(remaining.rows).toEqual([{ id: spare.id }]);
  });

  test("an attendee assignment queued after deletion cannot use the deleted status", async () => {
    const { attendeeId, seedId, spareId } = await setUpAssignmentRace();

    const deletion = attendeeStatusWrites.delete(spareId);
    const assignment = assignStatus(attendeeId, spareId);

    expect(await deletion).toEqual({ ok: true, value: undefined });
    await expect(assignment).rejects.toThrow("attendee status does not exist");
    expect(await storedAttendeeStatus(attendeeId)).toBe(seedId);
  });

  test("an attendee assignment queued before deletion makes the status in use", async () => {
    const { attendeeId, spareId } = await setUpAssignmentRace();

    const assignment = assignStatus(attendeeId, spareId);
    const deletion = attendeeStatusWrites.delete(spareId);

    await assignment;
    expect(await deletion).toEqual({ error: "status_in_use", ok: false });
    expect(await storedAttendeeStatus(attendeeId)).toBe(spareId);
  });

  test("deleting a status nobody holds removes it outright", async () => {
    const seed = await seedStatus();
    const spare = await addStatus("Free To Go");

    expect(await attendeeStatusWrites.delete(spare.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await getAttendeeStatus(spare.id)).toBeNull();
    expect(await getAttendeeStatus(seed.id)).not.toBeNull();
  });

  test("deleting a held status moves its attendees and logs the move", async () => {
    const busy = await addStatus("Busy");
    const other = await addStatus("Landing");
    const attendeeId = await createAttendeeWithStatus(busy.id);

    expect(await attendeeStatusWrites.delete(busy.id, other.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await storedAttendeeStatus(attendeeId)).toBe(other.id);
    expect(await getAttendeeStatus(busy.id)).toBeNull();
  });

  test("deleting a held status without a reachable target keeps everything", async () => {
    const seed = await seedStatus();
    const busy = await addStatus("Stuck");
    const attendeeId = await createAttendeeWithStatus(busy.id);

    expect(await attendeeStatusWrites.delete(busy.id, 999_999)).toEqual({
      error: "status_in_use",
      ok: false,
    });
    expect(await storedAttendeeStatus(attendeeId)).toBe(busy.id);
    expect(await getAttendeeStatus(busy.id)).not.toBeNull();
    expect(await getAttendeeStatus(seed.id)).not.toBeNull();
  });
});
