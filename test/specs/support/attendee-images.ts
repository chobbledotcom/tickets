/**
 * Pictures the organiser uploaded, and the notes that name them. A note names
 * a picture with a reference like ![Poster](img#7). Wherever the site writes
 * that note out, the picture shows at its own address and the reference is
 * gone. The helpers here seed the note and remember the picture, so the steps
 * can hold each page region to its own copy of it.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { hashEmail, saveContactRecord } from "#db/contact-preferences.ts";
import { getNoteRows } from "#db/notes/queries.ts";
import { t } from "#i18n";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { openRecord, recordFor } from "#test/specs/support/contact-records.ts";
import {
  emailFor,
  type NoteAPictureAboutOnePerson,
  type NoteImage,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The listing every note story books its person onto, so one note shows on
 * the person's page, the attendees list, and the listing's own panels. */
export const NOTE_LISTING = "Fayre";

/** The picture a story named, or a loud failure when none was seeded. */
const noteImage = (
  world: TicketsWorld,
): { alt: string; filename: string; id: number; noteText: string } => {
  expect(world.noteImage).toBeDefined();
  return world.noteImage!;
};

/** The picture, exactly as the site writes it: its own address in place of
 * the reference. */
export const pictureTag = (world: TicketsWorld): string => {
  const image = noteImage(world);
  return `<img src="/image/${encodeURI(image.filename)}" alt="${image.alt}">`;
};

/** The page region one opening marker opens. The marker can sit inside the
 * opening tag's attributes, so the scan starts at the `<tag` that holds it.
 * One pass over that tag's open and close tokens counts the nesting, so a
 * region that holds children does not end at a child's close. */
const regionFrom = (html: string, openMarker: string, tag: string): string => {
  const markerAt = html.indexOf(openMarker);
  if (markerAt < 0) return "";
  const openTag = `<${tag}`;
  let start = html.lastIndexOf(openTag, markerAt);
  // A match can sit inside a longer tag's name. Hold out for a real boundary.
  while (start >= 0 && !/[\s>]/.test(html[start + openTag.length] ?? "")) {
    start = html.lastIndexOf(openTag, start - 1);
  }
  if (start < 0) return "";
  const tokens = new RegExp(`<(/?)${tag}[\\s>]`, "g");
  tokens.lastIndex = start;
  let depth = 0;
  for (let m = tokens.exec(html); m !== null; m = tokens.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return "";
};

/** Hold one rendered region to the picture: its tag shows, and no img#
 * reference stays. The tag comes from the caller, so the note-picture checks
 * and the page-wide check share one assertion. */
const showsPicture =
  (tag: (world: TicketsWorld) => string) =>
  (region: string, world: TicketsWorld): void => {
    expect(region).toContain(tag(world));
    expect(region).not.toContain("img#");
  };

/** Hold one page region to its own copy of the picture. A match anywhere else
 * on the page never satisfies this. */
export const regionShowsPicture = (
  html: string,
  openMarker: string,
  tag: string,
  world: TicketsWorld,
): void => {
  const region = regionFrom(html, openMarker, tag);
  expect(region).not.toBe("");
  showsPicture(pictureTag)(region, world);
};

/** Hold the page as a whole to the picture: it shows at its own address, and
 * no reference stays anywhere on the page. */
export const pageShowsPicture = showsPicture(pictureTag);

/** The picture the story named, uploaded now. The world keeps it as the
 * picture the story's reference points at; the caller writes the words that
 * name it. */
export const uploadsAPicture = async (
  world: TicketsWorld,
  name: string,
): Promise<NoteImage> => {
  const image = await makeImage(name);
  const picture: NoteImage = {
    alt: name,
    filename: image.filename,
    id: image.id,
    noteText: "",
  };
  world.noteImage = picture;
  return picture;
};

/** Someone booked onto the note listing under their own email, with a
 * picture uploaded and the note typed around the picture's reference. The
 * world remembers the person and the picture; the caller writes the note
 * where their story does. */
const typedNoteWithPicture = async (
  world: TicketsWorld,
  who: string,
  name: string,
  wordsBefore: string,
): Promise<{ attendeeId: number; picture: NoteImage; typed: string }> => {
  const listing = await createTestListing({ name: NOTE_LISTING });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    who,
    emailFor(who),
  );
  const picture = await uploadsAPicture(world, name);
  world.attendeeId = attendee.id;
  world.things.remember("listing", NOTE_LISTING, listing);
  const typed = `${wordsBefore} ![${name}](img#${picture.id})`;
  return { attendeeId: attendee.id, picture, typed };
};

/** The organiser booked someone onto the note listing and wrote a note that
 * names the picture. The note goes in through the real note form, so the row
 * the site keeps is the one a browser would have made. */
export const notedAboutWithPicture = async (
  world: TicketsWorld,
  who: string,
  noteText: string,
  name: string,
): Promise<void> => {
  const { attendeeId, picture, typed } = await typedNoteWithPicture(
    world,
    who,
    name,
    noteText,
  );
  await adminFormPost(`/admin/attendee/${attendeeId}/note`, { note: typed });
  const [row] = await getNoteRows("attendee", [attendeeId]);
  world.noteImage = { ...picture, noteId: row!.id, noteText: typed };
};

/** The site keeps a private note about someone, with a picture named in it,
 * and that someone is booked with the email the record is filed under. */
export const recordNoteWithPicture: NoteAPictureAboutOnePerson = async (
  world,
  who,
  name,
) => {
  const { picture, typed } = await typedNoteWithPicture(
    world,
    who,
    name,
    "Called first.",
  );
  await saveContactRecord(await hashEmail(emailFor(who)), {
    adminBookingCount: 0,
    adminNotes: typed,
    contactCount: 0,
    lastContact: "",
    lastSubject: "",
    publicBookingCount: 0,
    visits: 0,
  });
  world.noteImage = { ...picture, noteText: typed };
};

/** Someone's record, opened through the same one-way code the record page
 * files them under. */
export const openRecordFor = (
  world: TicketsWorld,
  who: string,
): Promise<TestBrowser> => openRecord(world, emailFor(who));

/** The organiser saves someone's record with a note past the length limit,
 * with the picture named in it. The site re-renders the editor in place, so
 * the page they are left reading carries the refusal and the note they sent. */
export const saveRecordWithOverLongNote = async (
  world: TicketsWorld,
  who: string,
): Promise<TestBrowser> => {
  const image = noteImage(world);
  const overLong = `Still here. ![${image.alt}](img#${image.id}) ${"x".repeat(MAX_TEXTAREA_LENGTH)}`;
  const browser = await openRecordFor(world, who);
  await browser.submitForm(
    { admin_notes: overLong, public_booking_count: "0" },
    "Save record",
  );
  return browser;
};

/** The words the site shows when a note arrives past the length limit. */
export const noteTooLongMessage = (): string =>
  t("contact_history.note_too_long", { max: MAX_TEXTAREA_LENGTH });

/** The note the site kept about them, read back for the unchanged check. */
export const noteKeptAbout = async (who: string): Promise<string> =>
  (await recordFor(emailFor(who))).adminNotes;

/** The note page's own address for the note a story wrote. */
export const noteDeletePath = (world: TicketsWorld): string => {
  const noteId = world.noteImage?.noteId;
  expect(noteId).toBeDefined();
  return `/admin/attendee/${world.attendeeId}/note/${noteId}/delete`;
};
