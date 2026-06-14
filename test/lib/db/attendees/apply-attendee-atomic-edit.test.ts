import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  applyAttendeeAtomicEdit,
  createAttendeeAtomic,
  getAttendee,
  getAttendeesRaw,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Encrypt a minimal PII blob for the test attendee. Reuses the production
 * encryptPiiBlob path so the resulting blob decrypts correctly. */
const encryptTestBlob = async (
  name: string,
  email: string,
  ticketToken: string,
): Promise<string> => {
  const { buildPiiBlob, encryptPiiBlob } = await import(
    "#shared/db/attendees/pii.ts"
  );
  const { settings } = await import("#shared/db/settings.ts");
  const blob = buildPiiBlob({
    address: "",
    email,
    name,
    payment_id: "",
    phone: "",
    special_instructions: "",
    ticket_token: ticketToken,
  });
  const encrypted = await encryptPiiBlob(blob, settings.publicKey);
  if (!encrypted) throw new Error("Failed to encrypt test PII blob");
  return encrypted;
};

describeWithEnv(
  "db > attendees > applyAttendeeAtomicEdit",
  { db: true },
  () => {
    test("updates PII on a single-line attendee without touching the line", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const result = await bookAttendee(listing, {
        email: "before@example.com",
        name: "Before",
        quantity: 2,
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob(
        "After",
        "after@example.com",
        attendee.ticket_token,
      );

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: existing[0]!.key,
          listingId: listing.id,
          quantity: 2,
        },
      ]);
      expect(update.success).toBe(true);

      // PII changed
      const updated = await getAttendee(attendee.id, await getTestPrivateKey());
      expect(updated!.name).toBe("After");
      expect(updated!.email).toBe("after@example.com");
      // Line unchanged
      expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(2);
    });

    test("updates an existing line's quantity", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const result = await bookAttendee(listing, {
        name: "Qty",
        quantity: 1,
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob("Qty", "", attendee.ticket_token);

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: existing[0]!.key,
          listingId: listing.id,
          quantity: 4,
        },
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(4);
    });

    test("adds a new line alongside an existing one", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const result = await bookAttendee(listing1, {
        name: "Link",
        quantity: 1,
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob("Link", "", attendee.ticket_token);

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: existing[0]!.key,
          listingId: listing1.id,
          quantity: 1,
        },
        {
          date: null,
          durationDays: 1,
          exists: false,
          key: "",
          listingId: listing2.id,
          quantity: 2,
        },
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id))[0]!.quantity).toBe(2);
    });

    test("removes a line by omitting it from the desired set", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 1 },
          {
            listingId: listing2.id,
            quantity: 1,
          },
        ],
        email: "",
        name: "Multi",
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const listing1Key = existing.find(
        (e) => e.booking.listing_id === listing1.id,
      )!.key;
      const blob = await encryptTestBlob("Multi", "", attendee.ticket_token);

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: listing1Key,
          listingId: listing1.id,
          quantity: 1,
        },
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id)).length).toBe(0);
    });

    test("rejects when desired set is empty (no_lines)", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const result = await bookAttendee(listing, { name: "X", quantity: 1 });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const blob = await encryptTestBlob("X", "", attendee.ticket_token);
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, []);
      expect(update.success).toBe(false);
      if (!update.success) {
        expect(update.reason).toBe("no_lines");
      }
    });

    test("rejects duplicate (listingId, date) pairs up front", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const result = await bookAttendee(listing, { name: "X", quantity: 1 });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const blob = await encryptTestBlob("X", "", attendee.ticket_token);
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: false,
          key: "",
          listingId: listing.id,
          quantity: 1,
        },
        {
          date: null,
          durationDays: 1,
          exists: false,
          key: "",
          listingId: listing.id,
          quantity: 1,
        },
      ]);
      expect(update.success).toBe(false);
      if (!update.success) {
        expect(update.reason).toBe("capacity_exceeded");
      }
    });

    test("rejects an update that exceeds listing capacity", async () => {
      const listing = await createTestListing({ maxAttendees: 3 });
      const result = await bookAttendee(listing, { name: "X", quantity: 2 });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob("X", "", attendee.ticket_token);
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: existing[0]!.key,
          listingId: listing.id,
          quantity: 5,
        },
      ]);
      expect(update.success).toBe(false);
      if (!update.success) {
        expect(update.reason).toBe("capacity_exceeded");
      }
    });

    test("updates date on a daily line", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const result = await bookAttendee(listing, {
        date: "2026-04-07",
        quantity: 1,
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob("X", "", attendee.ticket_token);
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: "2026-04-08",
          durationDays: 1,
          exists: true,
          key: existing[0]!.key,
          listingId: listing.id,
          quantity: 1,
        },
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing.id))[0]!.date).toBe("2026-04-08");
    });

    test("leaves the attendee untouched when one line exceeds capacity", async () => {
      // All-or-nothing: an edit that deletes one line and changes the PII must
      // leave BOTH untouched when a different line can't fit. Regression guard
      // for the previous partial-commit behaviour (PII + DELETE committed while
      // the failing line silently no-op'd).
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({ maxAttendees: 3, name: "E2" });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 1 },
          { listingId: listing2.id, quantity: 2 },
        ],
        email: "before@example.com",
        name: "Before",
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const listing2Key = existing.find(
        (e) => e.booking.listing_id === listing2.id,
      )!.key;
      const blob = await encryptTestBlob(
        "After",
        "after@example.com",
        attendee.ticket_token,
      );

      // Omit the listing1 line (a removal) and push listing2 past its cap of 3.
      // The preflight rejects the whole edit before any write touches the DB.
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: null,
          durationDays: 1,
          exists: true,
          key: listing2Key,
          listingId: listing2.id,
          quantity: 5,
        },
      ]);
      expect(update.success).toBe(false);
      if (!update.success) expect(update.reason).toBe("capacity_exceeded");

      // Nothing committed: listing1 line still present, listing2 still qty 2, and
      // the PII (name/email) is unchanged.
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id))[0]!.quantity).toBe(2);
      const reloaded = await getAttendee(
        attendee.id,
        await getTestPrivateKey(),
      );
      expect(reloaded!.name).toBe("Before");
      expect(reloaded!.email).toBe("before@example.com");
    });

    test("updates only the targeted row when the same daily listing sits on two dates", async () => {
      // Regression guard for line identity: the UPDATE must pin the row by its
      // old start_at, or a quantity change to one date would match both rows.
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const result = await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-06-15",
            durationDays: 1,
            listingId: listing.id,
            quantity: 1,
          },
          {
            date: "2026-06-20",
            durationDays: 1,
            listingId: listing.id,
            quantity: 1,
          },
        ],
        email: "",
        name: "Two",
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const june15 = existing.find((e) =>
        e.booking.start_at?.startsWith("2026-06-15"),
      )!;
      const june20 = existing.find((e) =>
        e.booking.start_at?.startsWith("2026-06-20"),
      )!;
      const blob = await encryptTestBlob("Two", "", attendee.ticket_token);

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: "2026-06-15",
          durationDays: 1,
          exists: true,
          key: june15.key,
          listingId: listing.id,
          quantity: 4,
        },
        {
          date: "2026-06-20",
          durationDays: 1,
          exists: true,
          key: june20.key,
          listingId: listing.id,
          quantity: 1,
        },
      ]);
      expect(update.success).toBe(true);

      const after = await loadExistingLines(attendee.id);
      expect(after.length).toBe(2);
      const r15 = after.find((e) =>
        e.booking.start_at?.startsWith("2026-06-15"),
      )!;
      const r20 = after.find((e) =>
        e.booking.start_at?.startsWith("2026-06-20"),
      )!;
      expect(r15.booking.quantity).toBe(4);
      expect(r20.booking.quantity).toBe(1);
    });

    test("rejects a daily update whose range hits capacity on a middle day", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 1,
      });
      // Fill 2026-06-02 with another booking
      await bookAttendee(listing, {
        date: "2026-06-02",
        durationDays: 1,
        quantity: 1,
      });
      const target = await bookAttendee(listing, {
        date: "2026-06-10",
        durationDays: 1,
        quantity: 1,
      });
      if (!target.success) throw new Error("setup");
      const attendee = target.attendees[0]!;
      const existing = await loadExistingLines(attendee.id);
      const blob = await encryptTestBlob("X", "", attendee.ticket_token);
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        {
          date: "2026-06-01",
          durationDays: 3,
          exists: true,
          key: existing[0]!.key,
          listingId: listing.id,
          quantity: 1,
        },
      ]);
      expect(update.success).toBe(false);
    });
  },
);
