import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  createOwnerNote,
  createSystemNote,
  decryptNotes,
  deleteAttendeeNote,
  getAttendeeNote,
  getNoteRows,
  getNotesForAttendee,
  groupNotesByAttendee,
  loadNotesForAttendees,
  UNREADABLE_NOTE,
} from "#shared/db/system-notes.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

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
    "SELECT note FROM system_notes WHERE attendee_id = ? ORDER BY id",
    [attendeeId],
  );

describeWithEnv("db > system-notes", { db: true }, () => {
  test("stores and reads back a decrypted system note", async () => {
    const attendeeId = await makeAttendee();
    await createSystemNote(attendeeId, "Refunded: price changed");

    const notes = await getNotesForAttendee(
      attendeeId,
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      attendee_id: attendeeId,
      note: "Refunded: price changed",
      type: "system",
    });
  });

  test("stores and reads back a decrypted owner note", async () => {
    const attendeeId = await makeAttendee();
    await createOwnerNote(attendeeId, "Called to confirm dietary needs");

    const notes = await getNotesForAttendee(
      attendeeId,
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
    await createSystemNote(attendeeId, "system secret");
    // The symmetric encryption format is the enc:1: envelope, not the plaintext.
    const stored = await rawNote(attendeeId);
    expect(stored?.note.startsWith("enc:")).toBe(true);
    expect(stored?.note).not.toContain("system secret");

    const ownerAttendee = await makeAttendee("Owner Target");
    await createOwnerNote(ownerAttendee, "owner secret");
    const ownerStored = await rawNote(ownerAttendee);
    // The owner hybrid-RSA envelope is hyb:1:, again never the plaintext.
    expect(ownerStored?.note.startsWith("hyb:")).toBe(true);
    expect(ownerStored?.note).not.toContain("owner secret");
  });

  test("returns an attendee's notes oldest first", async () => {
    const attendeeId = await makeAttendee();
    await createSystemNote(attendeeId, "first");
    await createOwnerNote(attendeeId, "second");
    await createSystemNote(attendeeId, "third");

    const notes = await getNotesForAttendee(
      attendeeId,
      await getTestPrivateKey(),
    );
    expect(notes.map((n) => n.note)).toEqual(["first", "second", "third"]);
  });

  test("groups notes for several attendees by attendee id", async () => {
    const a = await makeAttendee("Alice Notes");
    const b = await makeAttendee("Bob Notes");
    await createSystemNote(a, "a1");
    await createSystemNote(b, "b1");
    await createSystemNote(a, "a2");

    const notes = await decryptNotes(
      await getNoteRows([a, b]),
      await getTestPrivateKey(),
    );
    const grouped = groupNotesByAttendee(notes);
    expect(grouped.get(a)?.map((n) => n.note)).toEqual(["a1", "a2"]);
    expect(grouped.get(b)?.map((n) => n.note)).toEqual(["b1"]);
  });

  test("getNoteRows returns nothing for an empty attendee list", async () => {
    expect(await getNoteRows([])).toEqual([]);
  });

  test("loadNotesForAttendees derives the key only when notes exist", async () => {
    const withNotes = await makeAttendee("Has Notes");
    const withoutNotes = await makeAttendee("No Notes");
    await createSystemNote(withNotes, "hi");

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
    await createSystemNote(owner, "scoped note");
    const [row] = await getNoteRows([owner]);
    const pk = await getTestPrivateKey();

    const found = await getAttendeeNote(owner, row!.id, pk);
    expect(found?.note).toBe("scoped note");

    // The same note id under a different attendee must not resolve.
    expect(await getAttendeeNote(other, row!.id, pk)).toBeNull();
    // A missing id resolves to null too.
    expect(await getAttendeeNote(owner, 9_999_999, pk)).toBeNull();
  });

  test("an undecryptable note degrades to a placeholder rather than throwing", async () => {
    const attendeeId = await makeAttendee();
    // A row whose ciphertext is garbage (rotated key, manual edit, restore).
    await execute(
      "INSERT INTO system_notes (attendee_id, type, note, created) VALUES (?, 'system', ?, ?)",
      [attendeeId, "not-a-valid-envelope", new Date().toISOString()],
    );

    const notes = await getNotesForAttendee(
      attendeeId,
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toBe(UNREADABLE_NOTE);
  });

  test("deleteAttendeeNote removes only the scoped note", async () => {
    const owner = await makeAttendee("Delete Owner");
    const other = await makeAttendee("Keep Owner");
    await createSystemNote(owner, "delete me");
    await createSystemNote(other, "keep me");
    const [ownerRow] = await getNoteRows([owner]);
    const [otherRow] = await getNoteRows([other]);

    // A wrong attendee id must not delete another attendee's note.
    await deleteAttendeeNote(other, ownerRow!.id);
    expect(await getNoteRows([owner])).toHaveLength(1);

    await deleteAttendeeNote(owner, ownerRow!.id);
    expect(await getNoteRows([owner])).toEqual([]);
    // The other attendee's note is untouched.
    expect((await getNoteRows([other]))[0]?.id).toBe(otherRow!.id);
  });
});
