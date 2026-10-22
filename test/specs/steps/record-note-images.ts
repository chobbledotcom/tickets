/**
 * The record and the person's page, where a note's picture shows, and what
 * the organiser is told when the site refuses to keep the note.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { regionShowsPicture } from "#test/specs/support/attendee-images.ts";
import {
  browserSeenBy,
  CUSTOMER,
  rememberBrowser,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import {
  noteKeptAbout,
  noteTooLongMessage,
  recordNoteWithPicture,
  saveRecordWithOverLongNote,
} from "#test/specs/support/record-note-images.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The region a rendered note shows in, on the record page and the person's
 * page alike. */
const RENDERED_NOTE = '<div class="contact-notes">';

Given(
  "the site has a note about {word} with a picture called {string} in it",
  // The step books the person and writes the note through the real forms, so
  // it needs headroom over the five-second default.
  { timeout: 15_000 },
  async function (
    this: TicketsWorld,
    who: string,
    name: string,
  ): Promise<void> {
    await recordNoteWithPicture(this, who, name);
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
  "the record's note shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    // The record page also carries the raw note in its editor box, so the
    // rendered note region is the only place this assertion can look.
    regionShowsPicture(
      browserSeenBy(this, CUSTOMER).currentHtml,
      RENDERED_NOTE,
      "div",
      this,
    );
  },
);

Then(
  "the stats \\/ notes panel shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    regionShowsPicture(
      scenarioBrowser(this).currentHtml,
      RENDERED_NOTE,
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
      RENDERED_NOTE,
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
    const typedBefore = requiredWorldValue(
      this.noteImage,
      "the picture a story named",
    ).noteText;
    expect(await noteKeptAbout(who)).toBe(typedBefore);
  },
);
