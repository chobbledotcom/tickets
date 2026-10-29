import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeStatuses,
  attendeeStatusWrites,
  getAttendeeStatus,
} from "#db/attendee-statuses.ts";
import { getDb, update, withTransaction } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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

/** The status write the admin save runs inside the atomic edit's transaction,
 * so the race below exercises the statement shape production uses. */
const assignStatus = (attendeeId: number, statusId: number): Promise<void> =>
  withTransaction(async (tx) => {
    await tx.execute(
      update("attendees", { status_id: statusId }, { id: attendeeId }),
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
    const seed = (await attendeeStatuses.getAll())[0]!;
    const spare = await attendeeStatuses.table.insert({ name: "Free To Go" });
    await getDb().execute(
      "UPDATE attendee_statuses AS status SET is_public_default = 0, is_paid_default = 0",
    );

    expect(await attendeeStatusWrites.delete(spare.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await getAttendeeStatus(spare.id)).toBeNull();
    expect(await getAttendeeStatus(seed.id)).not.toBeNull();
  });

  test("deleting a held status moves its attendees and logs the move", async () => {
    const busy = await attendeeStatuses.table.insert({ name: "Busy" });
    const other = await attendeeStatuses.table.insert({ name: "Landing" });
    await getDb().execute(
      "UPDATE attendee_statuses AS status SET is_public_default = 0, is_paid_default = 0",
    );
    const attendeeId = await createAttendeeWithStatus(busy.id);

    expect(await attendeeStatusWrites.delete(busy.id, other.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await storedAttendeeStatus(attendeeId)).toBe(other.id);
    expect(await getAttendeeStatus(busy.id)).toBeNull();
  });

  test("deleting a held status without a reachable target keeps everything", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;
    const busy = await attendeeStatuses.table.insert({ name: "Stuck" });
    await getDb().execute(
      "UPDATE attendee_statuses AS status SET is_public_default = 0, is_paid_default = 0",
    );
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
