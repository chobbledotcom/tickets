// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
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

/** The notes block the banner carries: every note, oldest first, right above
 * the tab strip. */
const BANNER_NOTES = '<section class="attendee-notes">';
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

When(
  "the organiser asks to remove that note",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, noteDeletePath(this));
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
