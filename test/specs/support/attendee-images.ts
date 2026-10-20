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
  type NoteImage,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Everyone a story talks about has an email the site files them under. */
const emailFor = (who: string): string => `${who.toLowerCase()}@example.com`;

/** The listing every note story books its person onto, so one note shows on
 * the person's page, the attendees list, and the listing's own panels. */
export const NOTE_LISTING = "Fayre";

/** The picture a story named, or a loud failure when none was seeded. */
const noteImage = (
  world: TicketsWorld,
): { alt: string; filename: string; id: number; noteText: string } =>
  requiredWorldValue(world.noteImage, "the picture a story named");

/** The picture, exactly as the site writes it: its own address in place of
 * the reference. */
export const pictureTag = (world: TicketsWorld): string => {
  const image = noteImage(world);
  return `<img src="/image/${encodeURI(image.filename)}" alt="${image.alt}">`;
};

/** The page region one opening marker opens. Counts nested tags of the same
 * kind, so a region that holds children does not end at a child's close. */
export const regionFrom = (
  html: string,
  openMarker: string,
  tag: string,
): string => {
  const start = html.indexOf(openMarker);
  if (start < 0) return "";
  const open = new RegExp(`<${tag}[\\s>]`, "g");
  const close = new RegExp(`</${tag}>`, "g");
  open.lastIndex = start;
  close.lastIndex = start;
  open.exec(html);
  let depth = 1;
  for (;;) {
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (nextClose === null) return "";
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return html.slice(start, nextClose.index + nextClose[0].length);
    }
  }
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
  expect(region).toContain(pictureTag(world));
  expect(region).not.toContain("img#");
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
  const listing = await createTestListing({ name: NOTE_LISTING });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    who,
    emailFor(who),
  );
  const image = await makeImage(name);
  const typed = `${noteText} ![${name}](img#${image.id})`;
  await adminFormPost(`/admin/attendee/${attendee.id}/note`, { note: typed });
  const [row] = await getNoteRows("attendee", [attendee.id]);
  world.noteImage = {
    alt: name,
    filename: image.filename,
    id: image.id,
    noteId: row!.id,
    noteText: typed,
  };
  world.attendeeId = attendee.id;
  world.things.remember("listing", NOTE_LISTING, listing);
};

/** The site keeps a private note about someone, with a picture named in it,
 * and that someone is booked with the email the record is filed under. */
export const recordNoteWithPicture = async (
  world: TicketsWorld,
  who: string,
  name: string,
): Promise<void> => {
  const listing = await createTestListing({ name: NOTE_LISTING });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    who,
    emailFor(who),
  );
  const image = await makeImage(name);
  const typed = `Called first. ![${name}](img#${image.id})`;
  await saveContactRecord(await hashEmail(emailFor(who)), {
    adminBookingCount: 0,
    adminNotes: typed,
    contactCount: 0,
    lastContact: "",
    lastSubject: "",
    publicBookingCount: 0,
    visits: 0,
  });
  world.noteImage = {
    alt: name,
    filename: image.filename,
    id: image.id,
    noteText: typed,
  };
  world.attendeeId = attendee.id;
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
