// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { ORGANISER } from "#test/specs/support/browser.ts";
import { settingsCopy } from "#test/specs/support/email-provider.ts";
import {
  BOXES_WITH_A_DEFAULT,
  defaultTheBoxOffers,
  emailTheSiteWouldSend,
  ownerAlreadyWrote,
  ownerWrites,
  SITES_OWN_WORDING,
  wordingKeptFor,
  wordingTheBoxesWouldSend,
} from "#test/specs/support/email-wording.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The two emails, under the words the story uses for them. */
const WHICH_EMAIL = { admin: "admin", confirmation: "confirmation" } as const;

type WhichEmail = keyof typeof WHICH_EMAIL;

/** A story's table of wording, read as the three parts the form offers. */
const wordingFrom = (table: {
  rowsHash(): Record<string, string>;
}): EmailContent => {
  const rows = table.rowsHash();
  return {
    html: rows.html ?? "",
    subject: rows.subject ?? "",
    text: rows.text ?? "",
  };
};

/** Wording an owner might plausibly have saved earlier. */
const WROTE_EARLIER: EmailContent = {
  html: "<p>Earlier wording</p>",
  subject: "Earlier subject",
  text: "Earlier wording",
};

Given(
  "the owner has written their own confirmation email",
  (): Promise<void> => ownerAlreadyWrote("confirmation", WROTE_EARLIER),
);

When(
  "the owner writes the {word} email as:",
  function (
    this: TicketsWorld,
    which: WhichEmail,
    table: { rowsHash(): Record<string, string> },
  ): Promise<void> {
    return ownerWrites(this, WHICH_EMAIL[which], wordingFrom(table));
  },
);

Then(
  "both email templates are offered by name",
  async function (this: TicketsWorld): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    for (const heading of [
      "settings.advanced.confirmation_email",
      "settings.advanced.admin_notification_email",
    ]) {
      expect(page).toContain(await settingsCopy(heading));
    }
  },
);

Then(
  "the boxes say to leave them blank for the site's own wording",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      `placeholder="${await settingsCopy("settings.advanced.leave_blank_default")}"`,
    );
  },
);

Then(
  "the site's own wording shows through the empty boxes",
  async function (this: TicketsWorld): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    for (const which of ["confirmation", "admin"] as const) {
      // The site's real defaults, read from the module that supplies them, so
      // a page showing some other wording behind the boxes fails here.
      expect(page).toContain(DEFAULT_TEMPLATES[which].subject);
      // "Behind" and not "in": every box is empty until the owner writes in
      // it. A page that filled one in would store the site's own wording as
      // the owner's the first time they pressed Save.
      expect(await wordingTheBoxesWouldSend(this, which)).toEqual(
        SITES_OWN_WORDING,
      );
    }
  },
);

Then(
  "there is a way to start from the site's own wording",
  async function (this: TicketsWorld): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(
      await settingsCopy("settings.advanced.edit_default_template"),
    );
    // Each box separately, because the link only copies the wording the box
    // already carries. A page with the right wording on one box and nothing
    // on the other three still fills three boxes with an empty string.
    for (const { box, part, which } of BOXES_WITH_A_DEFAULT) {
      expect(page).toContain(`data-fill-default="${box}"`);
      expect(defaultTheBoxOffers(page, box)).toBe(
        DEFAULT_TEMPLATES[which][part],
      );
    }
  },
);

Then(
  "the {word} email is kept exactly as it was written",
  async function (this: TicketsWorld, which: WhichEmail): Promise<void> {
    // Whatever the last table said, read back out of the store. Comparing all
    // three parts at once means a subject kept without its bodies fails.
    expect(await wordingKeptFor(WHICH_EMAIL[which])).toEqual(
      requiredWorldValue(this.wordingWritten, "the wording written"),
    );
  },
);

Then(
  "the {word} email goes back to the site's own wording",
  async function (this: TicketsWorld, which: WhichEmail): Promise<void> {
    const email = WHICH_EMAIL[which];
    // Nothing of the owner's own left on file...
    expect(await wordingKeptFor(email)).toEqual(SITES_OWN_WORDING);
    // ...and the email that would go out is the site's again, not a blank one.
    // Clearing the boxes and falling back are two separate things, and a story
    // about what the site sends has to see the second one happen.
    const sent = await emailTheSiteWouldSend(email);
    for (const part of ["subject", "html", "text"] as const) {
      expect(sent[part]).not.toBe("");
    }
  },
);

Then(
  "the owner is told the template syntax is wrong",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Invalid template syntax",
    );
  },
);
