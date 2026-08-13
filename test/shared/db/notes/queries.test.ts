import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { queryOne } from "#shared/db/client.ts";
import {
  createNamedSystemNote,
  createOwnerNote,
  createSystemNote,
  deleteNamedSystemNotes,
  deleteNotes,
  getNote,
  getNoteRows,
  getNoteRowsForListing,
  getNotesFor,
  loadNotesForAttendees,
  loadNotesForListing,
} from "#shared/db/notes/queries.ts";
import { openNotes } from "#shared/db/notes/sealing.ts";
import {
  attendeeNotes,
  groupNotesByTargetId,
} from "#shared/db/notes/target.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";

/** Create a listing + attendee and return the attendee id. */
const makeAttendee = async (name = "Note Target"): Promise<number> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    name,
    `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`,
  );
  return attendee.id;
};

const rawNote = (attendeeId: number): Promise<{ note: string } | null> =>
  queryOne<{ note: string }>(
    "SELECT note FROM system_notes WHERE entity_type = 'attendee' AND entity_id = ? ORDER BY id",
    [attendeeId],
  );

describeWithEnv("db > notes", { db: true }, () => {
  test("loads notes scoped to one listing's attendees only", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const other = await createTestListing({ maxAttendees: 50 });
    const mine = await createTestAttendee(
      listing.id,
      listing.slug,
      "Mine",
      "mine@example.com",
    );
    const theirs = await createTestAttendee(
      other.id,
      other.slug,
      "Theirs",
      "theirs@example.com",
    );
    await createSystemNote(attendeeNotes(mine.id), "Note on this listing");
    await createSystemNote(attendeeNotes(theirs.id), "Note on another listing");

    const rows = await getNoteRowsForListing(listing.id);
    expect(rows.map((r) => r.entity_id)).toEqual([mine.id]);

    const notes = await loadNotesForListing(listing.id, getTestPrivateKey);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toBe("Note on this listing");
  });

  test("loadNotesForListing returns [] without a key unwrap when none exist", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "NoNotes",
      "nonotes@example.com",
    );
    const key = spy(getTestPrivateKey);
    const notes = await loadNotesForListing(listing.id, key);
    expect(notes).toEqual([]);
    expect(key.calls).toHaveLength(0);
  });

  test("stores and reads back a decrypted system note", async () => {
    const attendeeId = await makeAttendee();
    await createSystemNote(
      attendeeNotes(attendeeId),
      "Refunded: price changed",
    );

    const notes = await getNotesFor(
      attendeeNotes(attendeeId),
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      entity_id: attendeeId,
      note: "Refunded: price changed",
      type: "system",
    });
  });

  test("stores and reads back a decrypted owner note", async () => {
    const attendeeId = await makeAttendee();
    await createOwnerNote(
      attendeeNotes(attendeeId),
      "Called to confirm dietary needs",
    );

    const notes = await getNotesFor(
      attendeeNotes(attendeeId),
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      note: "Called to confirm dietary needs",
      type: "owner",
    });
  });

  test("never stores note text in plaintext", async () => {
    const attendeeId = await makeAttendee();
    await createSystemNote(attendeeNotes(attendeeId), "system secret");
    // The symmetric encryption format is the enc:1: envelope, not the plaintext.
    const stored = await rawNote(attendeeId);
    expect(stored?.note.startsWith("enc:")).toBe(true);
    expect(stored?.note).not.toContain("system secret");

    const ownerAttendee = await makeAttendee("Owner Target");
    await createOwnerNote(attendeeNotes(ownerAttendee), "owner secret");
    const ownerStored = await rawNote(ownerAttendee);
    // The owner hybrid-RSA envelope is hyb:1:, again never the plaintext.
    expect(ownerStored?.note.startsWith("hyb:")).toBe(true);
    expect(ownerStored?.note).not.toContain("owner secret");
  });

  test("manages refund confirmations by exact indexed name, never their text", async () => {
    const attendeeId = await makeAttendee();
    const target = attendeeNotes(attendeeId);
    await createNamedSystemNote(target, "confirmation to remove", {
      key: "reference-one",
      purpose: "refund_confirmation",
    });
    await createNamedSystemNote(target, "different confirmation", {
      key: "reference-two",
      purpose: "refund_confirmation",
    });
    await createSystemNote(target, "ordinary note to keep");

    await deleteNamedSystemNotes(target, "refund_confirmation", [
      "reference-one",
      "reference-one",
    ]);

    expect(
      (await getNotesFor(target, await getTestPrivateKey())).map(
        (note) => note.note,
      ),
    ).toEqual([
      "different confirmation",
      "ordinary note to keep",
    ]);
  });

  test("refuses a second app-written note with the same indexed name", async () => {
    const target = attendeeNotes(await makeAttendee());
    const name = {
      key: "one-confirmation",
      purpose: "refund_confirmation",
    } as const;
    await createNamedSystemNote(target, "first", name);

    await expect(
      createNamedSystemNote(target, "duplicate", name),
    ).rejects.toThrow();
  });

  test("refuses an app-written note whose indexed name is empty", async () => {
    const target = attendeeNotes(await makeAttendee());

    await expect(
      createNamedSystemNote(target, "unreachable", {
        key: "",
        purpose: "refund_confirmation",
      }),
    ).rejects.toThrow("A named system note needs a key");
    expect(await getNoteRows("attendee", [target.id])).toEqual([]);
  });

  test("returns an attendee's notes oldest first", async () => {
    const attendeeId = await makeAttendee();
    await createSystemNote(attendeeNotes(attendeeId), "first");
    await createOwnerNote(attendeeNotes(attendeeId), "second");
    await createSystemNote(attendeeNotes(attendeeId), "third");

    const notes = await getNotesFor(
      attendeeNotes(attendeeId),
      await getTestPrivateKey(),
    );
    expect(notes.map((n) => n.note)).toEqual(["first", "second", "third"]);
  });

  test("groups notes for several attendees by attendee id", async () => {
    const a = await makeAttendee("Alice Notes");
    const b = await makeAttendee("Bob Notes");
    await createSystemNote(attendeeNotes(a), "a1");
    await createSystemNote(attendeeNotes(b), "b1");
    await createSystemNote(attendeeNotes(a), "a2");

    const notes = await openNotes(
      await getNoteRows("attendee", [a, b]),
      await getTestPrivateKey(),
    );
    const grouped = groupNotesByTargetId(notes);
    expect(grouped.get(a)?.map((n) => n.note)).toEqual(["a1", "a2"]);
    expect(grouped.get(b)?.map((n) => n.note)).toEqual(["b1"]);
  });

  test("getNoteRows returns nothing for an empty attendee list", async () => {
    expect(await getNoteRows("attendee", [])).toEqual([]);
  });

  test("loadNotesForAttendees derives the key only when notes exist", async () => {
    const withNotes = await makeAttendee("Has Notes");
    const withoutNotes = await makeAttendee("No Notes");
    await createSystemNote(attendeeNotes(withNotes), "hi");

    const lazyKey = spy(() => getTestPrivateKey());

    const none = await loadNotesForAttendees([withoutNotes], lazyKey);
    expect(none).toEqual([]);
    expect(lazyKey.calls).toHaveLength(0);

    const some = await loadNotesForAttendees(
      [withNotes, withoutNotes],
      lazyKey,
    );
    expect(some.map((n) => n.note)).toEqual(["hi"]);
    expect(lazyKey.calls).toHaveLength(1);
  });

  test("getAttendeeNote loads one note scoped to its attendee", async () => {
    const owner = await makeAttendee("Scoped Owner");
    const other = await makeAttendee("Other Owner");
    await createSystemNote(attendeeNotes(owner), "scoped note");
    const [row] = await getNoteRows("attendee", [owner]);
    const pk = await getTestPrivateKey();

    const found = await getNote(attendeeNotes(owner), row!.id, pk);
    expect(found?.note).toBe("scoped note");

    // The same note id under a different attendee must not resolve.
    expect(await getNote(attendeeNotes(other), row!.id, pk)).toBeNull();
    // A missing id resolves to null too.
    expect(await getNote(attendeeNotes(owner), 9_999_999, pk)).toBeNull();
  });

  test("deleteAttendeeNote removes only the scoped note", async () => {
    const owner = await makeAttendee("Delete Owner");
    const other = await makeAttendee("Keep Owner");
    await createSystemNote(attendeeNotes(owner), "delete me");
    await createSystemNote(attendeeNotes(other), "keep me");
    const [ownerRow] = await getNoteRows("attendee", [owner]);
    const [otherRow] = await getNoteRows("attendee", [other]);

    // A wrong attendee id must not delete another attendee's note.
    await deleteNotes(attendeeNotes(other), [ownerRow!.id]);
    expect(await getNoteRows("attendee", [owner])).toHaveLength(1);

    await deleteNotes(attendeeNotes(owner), [ownerRow!.id]);
    expect(await getNoteRows("attendee", [owner])).toEqual([]);
    // The other attendee's note is untouched.
    expect((await getNoteRows("attendee", [other]))[0]?.id).toBe(otherRow!.id);
  });

  test("deletes nothing, and asks the database nothing, for an empty list", async () => {
    const owner = await makeAttendee("Nothing To Delete");
    await createSystemNote(attendeeNotes(owner), "kept");

    // Empty deletes must not cost a round trip.
    const { roundTrips } = await runAndCountRoundTrips(() =>
      Promise.all([
        deleteNotes(attendeeNotes(owner), []),
        deleteNamedSystemNotes(
          attendeeNotes(owner),
          "refund_confirmation",
          [],
        ),
      ]),
    );

    expect(roundTrips).toBe(0);
    expect(await getNoteRows("attendee", [owner])).toHaveLength(1);
  });
});
