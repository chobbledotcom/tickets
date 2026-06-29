/**
 * Servicing §7 — exclusion from customer surfaces.
 *
 * Every admin/customer reader that lists "attendees" must exclude
 * `kind='servicing'` rows: the attendees browser, the dashboard "newest"
 * feed, bulk-email recipient resolution, the per-listing attendee table,
 * CSV export, refund-all / check-in counts, and merge candidate lookups.
 * Servicing holds consume capacity (§2) but never appear as people.
 *
 * Implementation contract (test-first):
 *   - The shared readers (`getAttendeesPage`, `getNewestAttendeesRaw`,
 *     `getAllAttendeePiiBlobs`, `getAttendeePiiBlobsForListings`,
 *     `getListingWithAttendeesRaw`, `getAttendeesByTokens`) add a
 *     `kind = 'attendee'` predicate; a sibling servicing reader returns only
 *     servicing rows.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobsForListings,
  getAttendeesByTokens,
  getAttendeesPage,
  getAttendeesRaw,
  getNewestAttendeesRaw,
} from "#shared/db/attendees/queries.ts";
import { getListingWithAttendeesRaw } from "#shared/db/listings.ts";
import {
  createServicingHold,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

const REAL_NAME = "Real Person";
const REAL_EMAIL = "real@example.com";
const HOLD_NAME = "Boiler Service";

/** Create a listing with one real attendee + one servicing hold — the mixed
 *  audience every exclusion assertion contrasts against. */
const createMixedAudience = async () => {
  const listing = await createTestListing({ maxAttendees: 10, name: "L" });
  await createTestAttendeeDirect(listing.id, REAL_NAME, REAL_EMAIL);
  const { id, ticketToken } = await createServicingHold({
    listing: { name: "L" },
  });
  return { holdId: id, listing, ticketToken };
};

const decryptNames = async (
  rows: import("#shared/types.ts").Attendee[],
): Promise<string[]> => {
  const { decryptAttendees } = await import("#shared/db/attendees.ts");
  const pk = await getTestPrivateKey();
  return (await decryptAttendees(rows, pk)).map((a) => a.name);
};

const kindsFor = async (ids: number[]): Promise<string[]> => {
  const { queryAll } = await import("#shared/db/client.ts");
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await queryAll<{ kind: string }>(
    `SELECT kind FROM attendees WHERE id IN (${placeholders})`,
    ids,
  );
  return rows.map((r) => r.kind);
};

describeWithEnv(
  "servicing §7 — exclusion from customer surfaces",
  { db: true },
  () => {
    test("the attendees browser excludes servicing (kind predicate on getAttendeesPage)", async () => {
      await createMixedAudience();
      const page = await getAttendeesPage({
        listingIds: null,
        page: 0,
        sort: "newest",
      });
      const names = await decryptNames(page.rows);
      expect(names).toContain(REAL_NAME);
      expect(names).not.toContain(HOLD_NAME);
    });

    test("the dashboard 'newest attendees' feed excludes servicing", async () => {
      const { listing } = await createMixedAudience();
      const { attendee: newest } = await createTestAttendeeDirect(
        listing.id,
        "Newest Real",
        "newest@example.com",
      );
      const newestRows = await getNewestAttendeesRaw(10);
      const ids = newestRows.map((a) => a.id);
      expect(ids).toContain(newest.id);
      const kinds = await kindsFor(ids);
      expect(kinds.every((k) => k !== SERVICING_KIND)).toBe(true);
    });

    test("bulk-email targets exclude servicing (all + per-listing)", async () => {
      const { listing } = await createMixedAudience();
      expect((await getAllAttendeePiiBlobs()).length).toBe(1);
      expect((await getAttendeePiiBlobsForListings([listing.id])).length).toBe(
        1,
      );
    });

    test("the per-listing attendee table excludes servicing (getListingWithAttendeesRaw)", async () => {
      const { holdId, listing } = await createMixedAudience();
      const result = await getListingWithAttendeesRaw(listing.id);
      expect(result?.attendeesRaw.some((a) => a.id === holdId)).toBe(false);
      expect(result?.attendeesRaw.length).toBe(1);
    });

    test("raw per-listing attendee reads exclude servicing", async () => {
      const { holdId, listing } = await createMixedAudience();
      const rows = await getAttendeesRaw(listing.id);
      expect(rows.some((a) => a.id === holdId)).toBe(false);
      expect(rows.length).toBe(1);
    });

    test("CSV export excludes servicing (shares the listing attendee reader)", async () => {
      const { listing } = await createMixedAudience();
      const body = await renderAdminPage(
        `/admin/listing/${listing.id}/attendees.csv`,
      );
      const rows = body.trim().split("\n");
      expect(rows.length).toBe(2);
      expect(body).toContain(REAL_NAME);
      expect(body).not.toContain(HOLD_NAME);
    });

    test("refund-all and check-in counts exclude servicing (no real line ⇒ no action)", async () => {
      // A servicing hold on a listing with zero real attendees yields no
      // refundable / checkable rows (the readers feed getListingWithAttendeesRaw).
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await createServicingHold({ listing: { name: "L" } });
      const result = await getListingWithAttendeesRaw(listing.id);
      expect(result?.attendeesRaw.length).toBe(0);
    });

    test("attendee merge candidate lookup excludes servicing (token resolves to null)", async () => {
      const { ticketToken } = await createServicingHold();
      const [resolved] = await getAttendeesByTokens([ticketToken]);
      expect(resolved).toBeNull();
    });
  },
);
