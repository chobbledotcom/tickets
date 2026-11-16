import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeStatuses,
  attendeeStatusOrder,
  attendeeStatusWrites,
  DEFAULT_ATTENDEE_STATUS_NAME,
  ensureDefaultAttendeeStatus,
  getAttendeeStatus,
  requirePaidDefaultStatus,
  requirePublicDefaultStatus,
  requirePublicStatusId,
} from "#db/attendee-statuses.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { getDb } from "#db/client.ts";
import { records } from "#db/record-table.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { statusInput } from "#test-utils/db-helpers/attendee-statuses.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("db > attendee statuses", { db: true }, () => {
  test("the migration seeds a single non-reservation default status", async () => {
    const statuses = await attendeeStatuses.getAll();
    expect(statuses).toHaveLength(1);
    const seed = statuses[0]!;
    expect(seed.name).toBe(DEFAULT_ATTENDEE_STATUS_NAME);
    expect(seed.isPublicDefault).toBe(true);
    expect(seed.isPaidDefault).toBe(true);
    expect(seed.isReservation).toBe(false);
    expect(seed.reservationAmount).toBe("0");
    expect(seed.sortOrder).toBe(0);
  });

  test("the seeded status is the word an operator sees", async () => {
    // The name is what an attendee's status reads as until anyone renames it,
    // so it has to be a real word rather than blank.
    expect(DEFAULT_ATTENDEE_STATUS_NAME).toBe("Confirmed");
  });

  test("saving a status that is not a default leaves it alone", async () => {
    const other = await records.attendee_statuses.insert({
      name: "Waitlist",
      sortOrder: 1,
    });

    // It holds neither default, and is not being asked to take one, so there
    // is nothing to refuse — only a status giving a default UP is refused.
    const saved = await attendeeStatusWrites.save(
      other.id,
      statusInput("Waitlist renamed"),
    );

    expect(saved.ok).toBe(true);
    expect((await getAttendeeStatus(other.id))?.name).toBe("Waitlist renamed");
  });

  test("a default status may be saved while keeping its defaults", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;

    // Keeping a default is not giving it up, so this must save rather than be
    // refused for leaving the site without one.
    const saved = await attendeeStatusWrites.save(
      seed.id,
      statusInput("Still confirmed", {
        isPaidDefault: true,
        isPublicDefault: true,
      }),
    );

    expect(saved.ok).toBe(true);
    expect((await getAttendeeStatus(seed.id))?.name).toBe("Still confirmed");
  });

  test("a new status taking the defaults takes them off the old one", async () => {
    const seed = (await attendeeStatuses.getAll())[0]!;

    const created = await attendeeStatusWrites.save(
      null,
      statusInput("Now the default", {
        isPaidDefault: true,
        isPublicDefault: true,
      }),
    );

    expect(created.ok).toBe(true);
    // Two statuses claiming the same default is the state this must never
    // leave behind — the old one gives them up as the new one takes them.
    const previous = await getAttendeeStatus(seed.id);
    expect(previous?.isPublicDefault).toBe(false);
    expect(previous?.isPaidDefault).toBe(false);
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
    await getDb().execute(
      sql`UPDATE attendee_statuses SET is_public_default = 0`,
    );
    attendeeStatuses.invalidate();
    await expect(requirePublicStatusId()).rejects.toThrow(
      "No attendee status has the required isPublicDefault flag",
    );
  });

  test("ensureDefaultAttendeeStatus is idempotent once a status exists", async () => {
    await ensureDefaultAttendeeStatus();
    expect(await attendeeStatuses.getAll()).toHaveLength(1);
  });

  test("inserting statuses returns them ordered by sort_order then id", async () => {
    const reserved = await records.attendee_statuses.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
      sortOrder: 2,
    });
    const waitlist = await records.attendee_statuses.insert({
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
    expect(reserved.isReservation).toBe(true);
    expect(reserved.reservationAmount).toBe("10%");
    const storedWaitlist = await getAttendeeStatus(waitlist.id);
    expect(storedWaitlist?.isPaidDefault).toBe(false);
    expect(storedWaitlist?.isPublicDefault).toBe(false);
    expect(storedWaitlist?.isReservation).toBe(false);
  });

  test("ordered rows swap two statuses' sort_order", async () => {
    const a = await records.attendee_statuses.insert({
      name: "A",
      sortOrder: 5,
    });
    const b = await records.attendee_statuses.insert({
      name: "B",
      sortOrder: 6,
    });
    await attendeeStatusOrder.swap({ first: a.id, second: b.id });
    expect((await getAttendeeStatus(a.id))?.sortOrder).toBe(6);
    expect((await getAttendeeStatus(b.id))?.sortOrder).toBe(5);
  });

  test("update changes fields and invalidates the cache", async () => {
    const created = await records.attendee_statuses.insert({
      name: "Pending",
    });
    await records.attendee_statuses.update(created.id, {
      isReservation: true,
      reservationAmount: "25",
    });
    const updated = await getAttendeeStatus(created.id);
    expect(updated?.isReservation).toBe(true);
    expect(updated?.reservationAmount).toBe("25");
  });

  test("deleteById removes a status", async () => {
    const created = await records.attendee_statuses.insert({ name: "Temp" });
    await records.attendee_statuses.delete(created.id);
    expect(await getAttendeeStatus(created.id)).toBeNull();
  });

  test("status name is encrypted at rest", async () => {
    const created = await records.attendee_statuses.insert({
      name: "VIP Guest",
    });
    const raw = await getDb().execute(
      sql`SELECT name FROM attendee_statuses WHERE id = ${created.id}`,
    );
    // Stored value is ciphertext, not the plaintext name.
    expect(String(raw.rows[0]!.name)).not.toBe("VIP Guest");
    // ...but it decrypts back to the plaintext name on read.
    expect((await getAttendeeStatus(created.id))?.name).toBe("VIP Guest");
  });

  test("ensureDefaultAttendeeStatus seeds and backfills null-status attendees", async () => {
    // Wipe the seed and insert an attendee with no status.
    await getDb().execute(sql`DELETE FROM attendee_statuses`);
    attendeeStatuses.invalidate();
    await getDb().execute(
      sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES ('2024-01-01T00:00:00Z', '', NULL)`,
    );
    const { rows } = await getDb().execute(
      sql`SELECT id FROM attendees ORDER BY id DESC LIMIT 1`,
    );
    const attendeeId = Number(rows[0]!.id);

    await ensureDefaultAttendeeStatus();

    const statuses = await attendeeStatuses.getAll();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      isPaidDefault: true,
      isPublicDefault: true,
      isReservation: false,
      name: DEFAULT_ATTENDEE_STATUS_NAME,
      reservationAmount: "0",
      sortOrder: 0,
    });
    const backfilled = await getDb().execute(
      sql`SELECT status_id FROM attendees WHERE id = ${attendeeId}`,
    );
    expect(Number(backfilled.rows[0]!.status_id)).toBe(statuses[0]!.id);
  });

  test("concurrent default changes leave one public and paid default", async () => {
    const first = await records.attendee_statuses.insert({ name: "First" });
    const second = await records.attendee_statuses.insert({
      name: "Second",
    });

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
          isPaidDefault: true,
          isPublicDefault: true,
          isReservation: false,
          name: "First",
          reservationAmount: "0",
          sortOrder: 0,
        },
      },
      {
        ok: true,
        value: {
          id: second.id,
          isPaidDefault: true,
          isPublicDefault: true,
          isReservation: false,
          name: "Second",
          reservationAmount: "0",
          sortOrder: 0,
        },
      },
    ]);

    const defaults = await getDb().execute(
      sql`SELECT status.is_public_default, status.is_paid_default
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
    const candidate = await records.attendee_statuses.insert({
      name: "Candidate",
    });
    await getDb().execute(
      sql`CREATE TRIGGER fail_candidate_status_update
       BEFORE UPDATE ON attendee_statuses
       WHEN NEW.id = ${sqlLiteral(candidate.id)}
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
      sql`SELECT status.id, status.is_public_default, status.is_paid_default
         FROM attendee_statuses AS status
        ORDER BY status.id`,
    );
    expect(defaults.rows).toEqual([
      { id: seed.id, is_paid_default: 1, is_public_default: 1 },
      { id: candidate.id, is_paid_default: 0, is_public_default: 0 },
    ]);
  });

  test("a stale edit cannot clear a newly selected default", async () => {
    const candidate = await records.attendee_statuses.insert({
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
        isPaidDefault: false,
        isPublicDefault: true,
        isReservation: false,
        name: "Candidate",
        reservationAmount: "0",
        sortOrder: 0,
      },
    });
    expect(await staleEdit).toEqual({
      error: "public_default_required",
      ok: false,
    });
    expect((await requirePublicDefaultStatus()).id).toBe(candidate.id);
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
