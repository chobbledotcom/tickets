// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  adaBooks,
  listingStillLists,
  organiserClearsOutRecords,
  organiserDeletesListing,
  organiserForgetsAda,
  organiserForgetsAStranger,
  organiserForgetsNobodyInParticular,
  organiserSavesChoices,
  POTTERY,
  timesTheSiteHasSeen,
  whatTheFormOffers,
  whatThePrivacyPageSays,
} from "#test/specs/support/privacy.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "Ada has booked the Pottery Class",
  function (this: TicketsWorld): Promise<void> {
    return adaBooks(this, false);
  },
);

Given(
  "Ada has booked the Pottery Class, giving an email and a phone number",
  function (this: TicketsWorld): Promise<void> {
    return adaBooks(this, true);
  },
);

When(
  "the organiser deletes the Pottery Class",
  function (this: TicketsWorld): Promise<void> {
    return organiserDeletesListing(this, POTTERY);
  },
);

When(
  "the organiser deletes the records left behind, choosing {string}",
  function (this: TicketsWorld, age: string): Promise<void> {
    return organiserClearsOutRecords(this, age);
  },
);

When(
  "the organiser saves {string} and turns automatic deleting off",
  function (this: TicketsWorld, age: string): Promise<void> {
    return organiserSavesChoices(this, age);
  },
);

Then(
  "the site says {int} record is left behind",
  async function (this: TicketsWorld, count: number): Promise<void> {
    expect(await whatThePrivacyPageSays(this)).toContain(
      t("privacy.orphans.count", { count }),
    );
  },
);

Then(
  "the site says no records are left behind",
  async function (this: TicketsWorld): Promise<void> {
    expect(await whatThePrivacyPageSays(this)).toContain(
      t("privacy.orphans.count", { count: 0 }),
    );
  },
);

Then(
  "the organiser is told {int} record was deleted",
  function (this: TicketsWorld, count: number): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("privacy.orphans.flash_purged", { count }),
    );
  },
);

Then(
  "the page comes back offering {string} with automatic deleting off",
  async function (this: TicketsWorld, age: string): Promise<void> {
    expect(await whatTheFormOffers(this)).toEqual({ age, byItself: false });
  },
);

When(
  "the organiser deletes the record kept about Ada's email",
  function (this: TicketsWorld): Promise<void> {
    return organiserForgetsAda(this, "email");
  },
);

When(
  "the organiser deletes the record kept about Ada's phone number",
  function (this: TicketsWorld): Promise<void> {
    return organiserForgetsAda(this, "phone");
  },
);

When(
  "the organiser deletes the record kept about an email nobody booked with",
  function (this: TicketsWorld): Promise<void> {
    return organiserForgetsAStranger(this);
  },
);

When(
  "the organiser deletes a record without saying whose",
  function (this: TicketsWorld): Promise<void> {
    return organiserForgetsNobodyInParticular(this);
  },
);

Then(
  "the organiser is told the record was deleted",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("privacy.erase.flash_done"),
    );
  },
);

Then(
  "the site counts nothing about Ada's email",
  async function (this: TicketsWorld): Promise<void> {
    expect(await timesTheSiteHasSeen("email")).toBe(0);
  },
);

Then(
  "the site counts nothing about Ada's phone number",
  async function (this: TicketsWorld): Promise<void> {
    expect(await timesTheSiteHasSeen("phone")).toBe(0);
  },
);

Then(
  "Ada is still booked on the Pottery Class",
  async function (this: TicketsWorld): Promise<void> {
    expect(await listingStillLists(this, POTTERY)).toBe(true);
  },
);

Then(
  "the organiser is told there was nothing to delete",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("privacy.erase.flash_none"),
    );
  },
);

Then(
  "the organiser is told to enter an email or phone number",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("privacy.erase.error_identifier"),
    );
  },
);
