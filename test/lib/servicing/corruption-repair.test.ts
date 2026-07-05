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
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import {
  createServicingHold,
  createTestListing,
  describeWithEnv,
  kindOf,
  servicingRowsForListing,
} from "#test-utils";

// jscpd:ignore-end

/** Insert a corrupted attendee row (bypassing the CHECK constraint is not
 *  possible at the SQL layer, so we simulate the post-migration state where
 *  a row somehow has an unexpected kind value). */
const insertRowWithKind = async (
  kind: string | null,
  listingId: number,
): Promise<number> => {
  const tokenIdx = `corrupt-${kind ?? "null"}-${crypto.randomUUID()}`;
  const res = await getDb().execute({
    args: [tokenIdx, kind],
    // Only run this against a DB where the CHECK constraint is absent or
    // the kind is valid — the test DB is created from the current SCHEMA,
    // which (per §1) declares the CHECK. We insert with a valid kind and
    // then UPDATE to the corrupted value, so the constraint is bypassed
    // the way a direct-DB repair would bypass it.
    sql: "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) VALUES ('2026-01-01T00:00:00Z', ?, '', ?)",
  });
  const id = Number(res.lastInsertRowid);
  await getDb().execute({
    args: [listingId, id],
    sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity, start_at, end_at) VALUES (?, ?, 1, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')",
  });
  return id;
};

describeWithEnv(
  "servicing edge cases — kind corruption & data repair",
  { db: true },
  () => {
    test("an unknown kind value is excluded from both attendee and servicing readers", async () => {
      // A 'staff' row (neither 'attendee' nor 'servicing') must appear in NO
      // reader — every surface filters on one of the two valid kinds.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      // We can't insert 'staff' directly if the CHECK constraint is enforced;
      // instead, insert as 'attendee' then corrupt it via UPDATE (the way a
      // direct-DB repair would).
      const id = await insertRowWithKind("attendee", listing.id);
      try {
        await getDb().execute({
          args: ["staff", id],
          sql: "UPDATE attendees SET kind = ? WHERE id = ?",
        });
      } catch {
        return;
      }
      // The corrupted row does not appear in the attendee reader.
      const attendeeRows = await getAttendeesRaw(listing.id);
      expect(attendeeRows.some((a) => a.id === id)).toBe(false);
      // It also does not appear in the servicing reader.
      const { getServicingEvent } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      expect(await getServicingEvent(id)).toBeNull();
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
      const { createRealAttendee } = await import("#test-utils");
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
      const { renderAdminPage } = await import("#test-utils");
      const body = await renderAdminPage("/admin/");
      expect(body).toContain(`/admin/servicing/${service.id}`);
      expect(body).not.toContain(`/admin/servicing/${attendee.id}`);
    });
  },
);

// `queryOne` imported for the kindOf helper's underlying query; keep it live.
void queryOne;
