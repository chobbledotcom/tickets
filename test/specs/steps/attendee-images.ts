// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { openAdminPage, scenarioBrowser } from "#test/specs/support/browser.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
// jscpd:ignore-end

import {
  NOTE_LISTING,
  noteDeletePath,
  notedAboutWithPicture,
  pictureTag,
  regionShowsPicture,
} from "#test/specs/support/attendee-images.ts";

/** The notes block on the person's page: every note, oldest first, right
 * above the tab strip. */
const NOTES_BLOCK = '<section class="attendee-notes">';
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

Then(
  "the notes block above the tabs shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      NOTES_BLOCK,
      "section",
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
    assertStringIncludes(browser.pageText, t("notes.delete_confirm"));
  },
);

Then(
  "the confirmation shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    assertStringIncludes(scenarioBrowser(this).currentHtml, pictureTag(this));
  },
);

Then(
  "the confirmation never shows the picture reference",
  function (this: TicketsWorld): void {
    assert(!scenarioBrowser(this).currentHtml.includes("img#"));
  },
);
