// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  browserSeenBy,
  CUSTOMER,
  openAdminPage,
  rememberBrowser,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
// jscpd:ignore-end

import {
  NOTE_LISTING,
  noteDeletePath,
  notedAboutWithPicture,
  noteKeptAbout,
  noteTooLongMessage,
  pictureTag,
  recordNoteWithPicture,
  regionShowsPicture,
  saveRecordWithOverLongNote,
} from "#test/specs/support/attendee-images.ts";

/** The notes block the banner carries: every note, oldest first, right above
 * the tab strip. */
const BANNER_NOTES = '<section class="attendee-notes">';
/** The rendered note in the outreach panel of the person's page. */
const OUTREACH_NOTE = '<div class="contact-notes">';
/** The expandable notes summary above the attendees list and the listing's
 * panels. */
const NOTES_SUMMARY = "attendee-notes-summary";

Given(
  "the organiser noted about {word} {string} with a picture called {string}",
  async function (
    this: TicketsWorld,
    who: string,
    noteText: string,
    name: string,
  ): Promise<void> {
    await notedAboutWithPicture(this, who, noteText, name);
  },
);

Given(
  "the site has a note about {word} with a picture called {string} in it",
  async function (
    this: TicketsWorld,
    who: string,
    name: string,
  ): Promise<void> {
    await recordNoteWithPicture(this, who, name);
  },
);

When(
  "the organiser opens {word}'s page",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    await openAdminPage(this, `/admin/attendees/${this.attendeeId}`);
  },
);

When(
  "the organiser opens the Attendees page",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, "/admin/attendees");
  },
);

When(
  "the organiser opens the listing's overview",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(
      this,
      `/admin/listing/${listingIdNamed(this, NOTE_LISTING)}`,
    );
  },
);

When(
  "the organiser opens the listing's roster",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(
      this,
      `/admin/listing/${listingIdNamed(this, NOTE_LISTING)}/attendees`,
    );
  },
);

/** The note's own "×", the link titled "Delete note". */
const NOTE_DELETE_MARK = "×";

When(
  "the organiser asks to remove that note",
  async function (this: TicketsWorld): Promise<void> {
    // The "×" beside the note is the way in. This step follows the link from
    // the page the story opened, and never opens the delete address itself.
    await scenarioBrowser(this).clickLink(NOTE_DELETE_MARK);
  },
);

When(
  "the organiser saves {word}'s record with a note past the length limit",
  async function (this: TicketsWorld, who: string): Promise<void> {
    rememberBrowser(
      this,
      CUSTOMER,
      await saveRecordWithOverLongNote(this, who),
    );
  },
);

Then(
  "the banner shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      'class="page-block attendee-banner"',
      "div",
      this,
    );
  },
);

Then(
  "the notes section shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      BANNER_NOTES,
      "section",
      this,
    );
  },
);

Then(
  "the outreach panel shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      OUTREACH_NOTE,
      "div",
      this,
    );
  },
);

Then(
  "the notes summary shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      NOTES_SUMMARY,
      "details",
      this,
    );
  },
);

Then(
  "the organiser is on the note's delete page",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.currentUrl).toBe(noteDeletePath(this));
    expect(browser.pageText).toContain(t("notes.delete_confirm"));
  },
);

Then(
  "the confirmation shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    expect(scenarioBrowser(this).currentHtml).toContain(pictureTag(this));
  },
);

Then(
  "the confirmation never shows the picture reference",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).currentHtml).not.toContain("img#");
  },
);

Then(
  "the record's note shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    // The record page also carries the raw note in its editor box, so the
    // rendered preview region is the only place this assertion can look.
    regionShowsPicture(
      browserSeenBy(this, CUSTOMER).currentHtml,
      OUTREACH_NOTE,
      "div",
      this,
    );
  },
);

Then(
  "the returned note shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      browserSeenBy(this, CUSTOMER).currentHtml,
      OUTREACH_NOTE,
      "div",
      this,
    );
  },
);

Then(
  "the organiser is told the note is too long",
  function (this: TicketsWorld): void {
    expect(browserSeenBy(this, CUSTOMER).pageText).toContain(
      noteTooLongMessage(),
    );
  },
);

Then(
  "the note kept about {word} still holds what was typed before",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await noteKeptAbout(who)).toBe(this.noteImage!.noteText);
  },
);
