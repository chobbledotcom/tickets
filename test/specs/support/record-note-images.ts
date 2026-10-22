/**
 * The note the record keeps about one person, with a picture named in it:
 * what the site seeds, and what a refused save leaves behind.
 */

// jscpd:ignore-start
import { hashEmail, saveContactRecord } from "#db/contact-preferences.ts";
import { t } from "#i18n";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { typedNoteWithPicture } from "#test/specs/support/attendee-images.ts";
import { openRecord, recordFor } from "#test/specs/support/contact-records.ts";
import { emailFor } from "#test/specs/support/emails.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** A story step that keeps a private note about someone, with a picture
 * named in it. */
type KeepsANoteWithPicture = (
  world: TicketsWorld,
  who: string,
  name: string,
) => Promise<void>;

/** The site keeps a private note about someone, with a picture named in it,
 * and that someone is booked with the email the record is filed under. */
export const recordNoteWithPicture: KeepsANoteWithPicture = async (
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

/** The organiser saves someone's record with a note past the length limit,
 * with the picture named in it. The site re-renders the editor in place, so
 * the page they are left reading carries the refusal and the note they sent. */
export const saveRecordWithOverLongNote = async (
  world: TicketsWorld,
  who: string,
): Promise<TestBrowser> => {
  const image = requiredWorldValue(
    world.noteImage,
    "the picture a story named",
  );
  const overLong = `Still here. ![${image.alt}](img#${image.id}) ${"x".repeat(MAX_TEXTAREA_LENGTH)}`;
  const browser = await openRecord(world, emailFor(who));
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
