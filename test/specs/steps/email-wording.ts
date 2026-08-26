// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { ORGANISER } from "#test/specs/support/browser.ts";
import { settingsCopy } from "#test/specs/support/email-provider.ts";
import {
  ownerAlreadyWrote,
  ownerWrites,
  SITES_OWN_WORDING,
  wordingKeptFor,
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
  function (this: TicketsWorld): void {
    const page = whatTheyWereTold(this, ORGANISER);
    // The site's real defaults, read from the module that supplies them, so a
    // page showing some other wording as its placeholder fails here.
    for (const which of ["confirmation", "admin"] as const) {
      expect(page).toContain(DEFAULT_TEMPLATES[which].subject);
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
    // The link is what the page offers; the wording it fills in has to be
    // carried on the box itself, or pressing it fills in nothing.
    for (const box of [
      "confirmation_html",
      "confirmation_text",
      "admin_html",
      "admin_text",
    ]) {
      expect(page).toContain(`data-fill-default="${box}"`);
    }
    expect(page).toContain("data-default-tpl=");
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
    expect(await wordingKeptFor(WHICH_EMAIL[which])).toEqual(SITES_OWN_WORDING);
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
