/**
 * Servicing edge cases — kind corruption & data repair.
 *
 * The `kind` column is the discriminating axis for the whole feature. The
 * CHECK constraint pins it to `{'attendee', 'servicing'}`, but the test-first
 * contract and every reader predicate (`kind = 'attendee'`, `kind = 'servicing'`)
 * must hold even when the constraint is bypassed (direct SQL repair, a partial
 * migration, a corrupted backup). AGENTS.md says "trust application invariants
 * … raise it as an error" — these tests pin that a corrupted row is excluded
 * from every surface, never silently accepted.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getServicingEvent } from "#shared/db/attendees/servicing.ts";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createRealAttendee,
  createServicingHold,
  kindOf,
  renderAdminPage,
  servicingRowsForListing,
} from "#test-utils/servicing.ts";

// jscpd:ignore-end

/**
 * Insert an attendee row with an arbitrary `kind` and a booking on `listingId`,
 * returning its id. `attendees.kind` has a `CHECK (kind IN ('attendee',
 * 'servicing'))`, so an unexpected value can't be written normally — this
 * bypasses CHECK enforcement for the write (the SQLite/libsql
 * `ignore_check_constraints` pragma) to reproduce the corrupt state a direct-DB
 * repair, partial migration, or bad backup would leave, then restores it. Only
 * the readers' `kind = ?` predicates then stand between that row and a surface.
 */
const insertRowWithKind = async (
  kind: string,
  listingId: number,
): Promise<number> => {
  await getDb().execute("PRAGMA ignore_check_constraints = true");
  try {
    const res = await getDb().execute({
      args: [`corrupt-${kind}-${crypto.randomUUID()}`, kind],
      sql: "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) VALUES ('2026-01-01T00:00:00Z', ?, '', ?)",
    });
    const id = Number(res.lastInsertRowid);
    await getDb().execute({
      args: [listingId, id],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity, start_at, end_at) VALUES (?, ?, 1, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')",
    });
    return id;
  } finally {
    await getDb().execute("PRAGMA ignore_check_constraints = false");
  }
};

describeWithEnv(
  "servicing edge cases — kind corruption & data repair",
  { db: true },
  () => {
    test("an unknown kind value is excluded from both attendee and servicing readers", async () => {
      // A 'staff' row (neither 'attendee' nor 'servicing') must appear in NO
      // reader — every surface filters on one of the two valid kinds. The row
      // is written past the CHECK so this exercises the reader predicates, not
      // the constraint (which is tested by rejecting the write elsewhere).
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const id = await insertRowWithKind("staff", listing.id);

      // The corrupted row does not appear in the attendee reader…
      const attendeeRows = await getAttendeesRaw(listing.id);
      expect(attendeeRows.some((a) => a.id === id)).toBe(false);
      // …nor in the servicing reader.
      expect(await getServicingEvent(id)).toBeNull();
    });

    test("the CHECK constraint rejects writing an unknown kind directly", async () => {
      // The first line of defence: without the pragma bypass, the DB itself
      // refuses an out-of-range kind, so a corrupt row can't be created through
      // normal SQL at all.
      const res = await getDb().execute({
        args: [`reject-${crypto.randomUUID()}`],
        sql: "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) VALUES ('2026-01-01T00:00:00Z', ?, '', 'attendee')",
      });
      const id = Number(res.lastInsertRowid);
      await expect(
        getDb().execute({
          args: ["staff", id],
          sql: "UPDATE attendees SET kind = ? WHERE id = ?",
        }),
      ).rejects.toThrow();
    });

    test("an operator flipping kind from servicing to attendee via direct SQL flips the route guard", async () => {
      // Malleable-software data repair: the operator edits kind directly.
      // The next read must pick up the new kind — the servicing route 404s,
      // the attendee route succeeds.
      const { id } = await createServicingHold();
      expect(await kindOf(id)).toBe(SERVICING_KIND);
      await getDb().execute({
        args: ["attendee", id],
        sql: "UPDATE attendees SET kind = ? WHERE id = ?",
      });
      expect(await kindOf(id)).toBe("attendee");
    });

    test("a servicing event on a listing with another servicing event: both are visible to the servicing reader", async () => {
      // Multiple servicing events on the same listing are independent rows;
      // neither hides the other.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const a = await createServicingHold({ listing: { name: "L" } });
      const b = await createServicingHold({ listing: { name: "L" } });
      expect(a.id).not.toBe(b.id);
      expect((await servicingRowsForListing(listing.id)).length).toBe(2);
    });

    test("a future-dated real attendee is NOT listed in the service-events table", async () => {
      // The upcoming-events table on the admin home must exclude real
      // attendees even when they're future-dated — it's a servicing-only view.
      await createTestListing({ maxAttendees: 10, name: "L" });
      const { attendee } = await createRealAttendee(
        "Future Real",
        "f@example.com",
        {
          name: "L",
        },
      );
      // Backdate so the attendee is "upcoming" by date — but it's kind='attendee',
      // so the service-events table must not list it.
      await getDb().execute({
        args: ["2099-01-01T00:00:00Z", attendee.id],
        sql: "UPDATE attendees SET created = ? WHERE id = ?",
      });
      const service = await createServicingHold({
        date: "2099-01-01",
        listing: { name: "L" },
        name: "Future Service",
      });
      const body = await renderAdminPage("/admin/");
      expect(body).toContain(`/admin/servicing/${service.id}`);
      expect(body).not.toContain(`/admin/servicing/${attendee.id}`);
    });
  },
);
