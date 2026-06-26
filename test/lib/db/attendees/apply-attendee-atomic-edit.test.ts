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

type DesiredLine = Parameters<typeof applyAttendeeAtomicEdit>[2][number];
type LineOpts = {
  date?: string | null;
  durationDays?: number;
  quantity?: number;
};
type ExistingLines = Awaited<ReturnType<typeof loadExistingLines>>;

/** A desired line that keeps/edits an existing booking, matched by `key`. */
const keepLine = (
  listingId: number,
  key: string,
  opts: LineOpts = {},
): DesiredLine => ({
  date: opts.date ?? null,
  durationDays: opts.durationDays ?? 1,
  exists: true,
  key,
  listingId,
  quantity: opts.quantity ?? 1,
});

/** A desired line for a brand-new booking (no existing key). */
const addLine = (listingId: number, opts: LineOpts = {}): DesiredLine => ({
  date: opts.date ?? null,
  durationDays: opts.durationDays ?? 1,
  exists: false,
  key: "",
  listingId,
  quantity: opts.quantity ?? 1,
});

/** Assert an edit was rejected up front with `reason`, leaving the DB untouched. */
const expectRejected = (
  update: Awaited<ReturnType<typeof applyAttendeeAtomicEdit>>,
  reason: string,
): void => {
  expect(update.success).toBe(false);
  if (!update.success) expect(update.reason).toBe(reason);
};

/** Assert each listing currently has the expected number of attendee rows. */
const expectRawCounts = async (
  pairs: Array<[{ id: number }, number]>,
): Promise<void> => {
  for (const [listing, count] of pairs) {
    expect((await getAttendeesRaw(listing.id)).length).toBe(count);
  }
};

/** The loaded line whose booking's listing matches `listingId`. */
const keyFor = (existing: ExistingLines, listingId: number): string =>
  existing.find((e) => e.booking.listing_id === listingId)!.key;

/** Book a single-line attendee, then load its lines and an edit PII blob. */
const bookForEdit = async (
  listing: { id: number },
  opts: Parameters<typeof bookAttendee>[1],
  blobName = "X",
  blobEmail = "",
) => {
  const result = await bookAttendee(listing, opts);
  if (!result.success) throw new Error("setup");
  const attendee = result.attendees[0]!;
  const existing = await loadExistingLines(attendee.id);
  const blob = await encryptTestBlob(
    blobName,
    blobEmail,
    attendee.ticket_token,
  );
  return { attendee, blob, existing };
};

/** Create a fresh listing and book a single-line attendee on it. */
const bookOnNewListing = async (
  listingOpts: Parameters<typeof createTestListing>[0],
  opts: Parameters<typeof bookAttendee>[1],
  blobName = "X",
  blobEmail = "",
) => {
  const listing = await createTestListing(listingOpts);
  return {
    listing,
    ...(await bookForEdit(listing, opts, blobName, blobEmail)),
  };
};

/** Create the two-listing fixture this suite reuses (E1, E2). */
const twoListings = async (
  caps: [number, number] = [10, 10],
): Promise<{ listing1: { id: number }; listing2: { id: number } }> => ({
  listing1: await createTestListing({ maxAttendees: caps[0], name: "E1" }),
  listing2: await createTestListing({ maxAttendees: caps[1], name: "E2" }),
});

/** Create a multi-line attendee, then load its lines and an edit PII blob. */
const setupMulti = async (
  bookings: Parameters<typeof createAttendeeAtomic>[0]["bookings"],
  createPii: { name: string; email?: string },
  blobPii: { name?: string; email?: string } = createPii,
) => {
  const result = await createAttendeeAtomic({
    bookings,
    email: createPii.email ?? "",
    name: createPii.name,
  });
  if (!result.success) throw new Error("setup");
  const attendee = result.attendees[0]!;
  const existing = await loadExistingLines(attendee.id);
  const blob = await encryptTestBlob(
    blobPii.name ?? createPii.name,
    blobPii.email ?? "",
    attendee.ticket_token,
  );
  return { attendee, blob, existing };
};

describeWithEnv(
  "db > attendees > applyAttendeeAtomicEdit",
  { db: true },
  () => {
    test("update with a key that misses existingByKey falls back to null/0 defaults", async () => {
      // When a line has exists:true but a key not in the existing-row map, the code
      // falls back to oldStartAt=null and oldParentListingId=0. For a standard
      // non-dated booking those defaults match the actual row, so the edit succeeds.
      const { listing, attendee, blob } = await bookOnNewListing(
        { maxAttendees: 10 },
        { name: "X", quantity: 1 },
      );
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, "no-such-key"),
      ]);
      expect(update.success).toBe(true);
    });

    test("updates PII on a single-line attendee without touching the line", async () => {
      const { listing, attendee, blob, existing } = await bookOnNewListing(
        { maxAttendees: 10 },
        { email: "before@example.com", name: "Before", quantity: 2 },
        "After",
        "after@example.com",
      );

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, existing[0]!.key, { quantity: 2 }),
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
      const { listing, attendee, blob, existing } = await bookOnNewListing(
        { maxAttendees: 10, maxQuantity: 5 },
        { name: "Qty", quantity: 1 },
        "Qty",
      );

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, existing[0]!.key, { quantity: 4 }),
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(4);
    });

    test("adds a new line alongside an existing one", async () => {
      const { listing1, listing2 } = await twoListings();
      const { attendee, blob, existing } = await bookForEdit(
        listing1,
        { name: "Link", quantity: 1 },
        "Link",
      );

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing1.id, existing[0]!.key, { quantity: 1 }),
        addLine(listing2.id, { quantity: 2 }),
      ]);
      expect(update.success).toBe(true);
      await expectRawCounts([
        [listing1, 1],
        [listing2, 1],
      ]);
      expect((await getAttendeesRaw(listing2.id))[0]!.quantity).toBe(2);
    });

    test("removes a line by omitting it from the desired set", async () => {
      const { listing1, listing2 } = await twoListings();
      const { attendee, blob, existing } = await setupMulti(
        [
          { listingId: listing1.id, quantity: 1 },
          { listingId: listing2.id, quantity: 1 },
        ],
        { name: "Multi" },
      );

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing1.id, keyFor(existing, listing1.id), { quantity: 1 }),
      ]);
      expect(update.success).toBe(true);
      await expectRawCounts([
        [listing1, 1],
        [listing2, 0],
      ]);
    });

    test("rejects when desired set is empty (no_lines)", async () => {
      const { attendee, blob } = await bookOnNewListing(
        { maxAttendees: 10 },
        { name: "X", quantity: 1 },
      );
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, []);
      expectRejected(update, "no_lines");
    });

    test("rejects duplicate (listingId, date) pairs up front", async () => {
      const { listing, attendee, blob } = await bookOnNewListing(
        { maxAttendees: 10 },
        { name: "X", quantity: 1 },
      );
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        addLine(listing.id, { quantity: 1 }),
        addLine(listing.id, { quantity: 1 }),
      ]);
      expectRejected(update, "capacity_exceeded");
    });

    test("rejects an update that exceeds listing capacity", async () => {
      const { listing, attendee, blob, existing } = await bookOnNewListing(
        { maxAttendees: 3 },
        { name: "X", quantity: 2 },
      );
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, existing[0]!.key, { quantity: 5 }),
      ]);
      expectRejected(update, "capacity_exceeded");
    });

    test("updates date on a daily line", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const { attendee, blob, existing } = await bookForEdit(listing, {
        date: "2026-04-07",
        quantity: 1,
      });
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, existing[0]!.key, { date: "2026-04-08" }),
      ]);
      expect(update.success).toBe(true);
      expect((await getAttendeesRaw(listing.id))[0]!.date).toBe("2026-04-08");
    });

    test("leaves the attendee untouched when one line exceeds capacity", async () => {
      // All-or-nothing: an edit that deletes one line and changes the PII must
      // leave BOTH untouched when a different line can't fit. Regression guard
      // for the previous partial-commit behaviour (PII + DELETE committed while
      // the failing line silently no-op'd).
      const { listing1, listing2 } = await twoListings([10, 3]);
      const { attendee, blob, existing } = await setupMulti(
        [
          { listingId: listing1.id, quantity: 1 },
          { listingId: listing2.id, quantity: 2 },
        ],
        { email: "before@example.com", name: "Before" },
        { email: "after@example.com", name: "After" },
      );

      // Omit the listing1 line (a removal) and push listing2 past its cap of 3.
      // The preflight rejects the whole edit before any write touches the DB.
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing2.id, keyFor(existing, listing2.id), { quantity: 5 }),
      ]);
      expectRejected(update, "capacity_exceeded");

      // Nothing committed: listing1 line still present, listing2 still qty 2, and
      // the PII (name/email) is unchanged.
      await expectRawCounts([[listing1, 1]]);
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
      const { attendee, blob, existing } = await setupMulti(
        [
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
        { name: "Two" },
      );
      const startsOn = (lines: ExistingLines, day: string) =>
        lines.find((e) => e.booking.start_at?.startsWith(day))!;

      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, startsOn(existing, "2026-06-15").key, {
          date: "2026-06-15",
          quantity: 4,
        }),
        keepLine(listing.id, startsOn(existing, "2026-06-20").key, {
          date: "2026-06-20",
          quantity: 1,
        }),
      ]);
      expect(update.success).toBe(true);

      const after = await loadExistingLines(attendee.id);
      expect(after.length).toBe(2);
      expect(startsOn(after, "2026-06-15").booking.quantity).toBe(4);
      expect(startsOn(after, "2026-06-20").booking.quantity).toBe(1);
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
      const { attendee, blob, existing } = await bookForEdit(listing, {
        date: "2026-06-10",
        durationDays: 1,
        quantity: 1,
      });
      const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
        keepLine(listing.id, existing[0]!.key, {
          date: "2026-06-01",
          durationDays: 3,
        }),
      ]);
      expect(update.success).toBe(false);
    });
  },
);
