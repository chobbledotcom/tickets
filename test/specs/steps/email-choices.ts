/** Somebody the site emails follows the link in their copy and chooses what
 * may be sent to them. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  browserSeenBy,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  sendsWhatWasPreviewed,
  theOneWhoAsked,
  whatWasSentTo,
  writesToListing,
} from "#test/specs/support/bulk-email.ts";
import {
  addressOfTheReader,
  asksToStopHearing,
  CHOICES_PATH,
  changesTheirMind,
  choicesLinkIn,
  countedAsAskedNotToHear,
  deletesTheirData,
  followsChoicesLink,
  hasAskedNotToHear,
  pageOffersChoice,
  READER,
  recordKeptUnderTheirCode,
} from "#test/specs/support/email-choices.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The person in the scenarios that never send an email first: somebody the
 * site has seen before, acting on their own page. */
const SOMEBODY = "reader@example.com";

Given(
  "the owner has sent a promotion to {string} saying {string}",
  async function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    await writesToListing(this, listingName, {
      body: words,
      marketing: true,
      subject: "About your booking",
    });
    await sendsWhatWasPreviewed(this);
  },
);

When(
  "one of them follows the choices link in their copy",
  async function (this: TicketsWorld): Promise<void> {
    const who = theOneWhoAsked();
    await followsChoicesLink(
      this,
      who,
      choicesLinkIn(whatWasSentTo(this, who)),
    );
  },
);

Then(
  "they land on their own choices page, still subscribed to promotions",
  function (this: TicketsWorld): void {
    const browser = browserSeenBy(this, READER);
    expect(browser.currentUrl).toBe(CHOICES_PATH);
    expect(browser.pageText).toContain(t("unsubscribe.subscribed_message"));
  },
);

When(
  "they ask to stop hearing about promotions",
  async function (this: TicketsWorld): Promise<void> {
    await asksToStopHearing(this);
  },
);

// The words the site says back are pinned from the route's own flash
// messages (src/features/public/unsubscribe.ts), which live outside the
// message catalog.
Then(
  "they are told they have unsubscribed",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, READER)).toContain(
      "You've unsubscribed from our marketing emails.",
    );
  },
);

Then(
  "the site counts them as having asked not to hear",
  async function (this: TicketsWorld): Promise<void> {
    expect(await countedAsAskedNotToHear(addressOfTheReader(this))).toBe(true);
  },
);

Then(
  "their page offers them a way back in",
  function (this: TicketsWorld): void {
    expect(pageOffersChoice(browserSeenBy(this, READER), "resubscribe")).toBe(
      true,
    );
  },
);

Given(
  "somebody has asked not to hear about promotions",
  async function (this: TicketsWorld): Promise<void> {
    await hasAskedNotToHear(this, SOMEBODY);
  },
);

When(
  "they change their mind on their own choices page",
  async function (this: TicketsWorld): Promise<void> {
    await changesTheirMind(this);
  },
);

Then(
  "they are told they have resubscribed",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, READER)).toContain(
      "You've resubscribed to our marketing emails.",
    );
  },
);

Then(
  "the site counts them as hearing about promotions again",
  async function (this: TicketsWorld): Promise<void> {
    expect(await countedAsAskedNotToHear(addressOfTheReader(this))).toBe(false);
  },
);

When(
  "they delete their data from their choices page",
  async function (this: TicketsWorld): Promise<void> {
    await deletesTheirData(this);
  },
);

Then(
  "they are told their record was deleted",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, READER)).toContain(
      "Your contact record has been deleted.",
    );
  },
);

Then(
  "the site keeps no record under their code",
  async function (this: TicketsWorld): Promise<void> {
    expect(await recordKeptUnderTheirCode(addressOfTheReader(this))).toBe(
      false,
    );
  },
);

When(
  "somebody opens the choices page from a broken link",
  async function (this: TicketsWorld): Promise<void> {
    rememberBrowser(this, READER, await openAsNewcomer(CHOICES_PATH));
  },
);

Then("they are told the link is invalid", function (this: TicketsWorld): void {
  expect(browserSeenBy(this, READER).pageText).toContain(
    t("unsubscribe.invalid_link"),
  );
});

Then(
  "the page offers them nothing to press",
  function (this: TicketsWorld): void {
    expect(browserSeenBy(this, READER).offersAWayToPost(CHOICES_PATH)).toBe(
      false,
    );
  },
);
