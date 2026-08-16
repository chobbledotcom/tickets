/** An owner writes to the people who booked, checks it over, and sends it. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  addressesWrittenTo,
  addressOf,
  bookedOnto,
  bookersFor,
  listingOffersEmailAction,
  type MessageWritten,
  ownerHasAnEmailProvider,
  peopleBookOnto,
  personBooksDays,
  previewOffersADraftToSendThemselves,
  sendsWhatWasPreviewed,
  siteOffersToSend,
  theOneWhoAsked,
  timesTheProviderWasAsked,
  watchWhatIsSent,
  wordsTheyWrote,
  writesToListing,
  writesToListingDay,
} from "#test/specs/support/bulk-email.ts";
import { asksNotToHearAboutPromotions } from "#test/specs/support/email-choices.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Book people onto a listing, with the watch on the outside world standing by
 * first. Even a story with no provider set up needs it: a send that should have
 * been refused would otherwise reach a real address. */
const booksPeople = (
  world: TicketsWorld,
  listingName: string,
  addresses: string[],
): Promise<void> => {
  if (!world.messagesOut) watchWhatIsSent(world);
  return peopleBookOnto(world, listingName, addresses);
};

Given(
  "the owner has an email provider of their own",
  function (this: TicketsWorld): Promise<void> {
    watchWhatIsSent(this);
    return ownerHasAnEmailProvider();
  },
);

Given(
  "{int} person/people have/has booked onto {string}",
  function (
    this: TicketsWorld,
    howMany: number,
    listingName: string,
  ): Promise<void> {
    return booksPeople(this, listingName, bookersFor(howMany));
  },
);

Given(
  "{int} person/people have/has booked onto {string} leaving no address",
  function (
    this: TicketsWorld,
    howMany: number,
    listingName: string,
  ): Promise<void> {
    return booksPeople(this, listingName, Array(howMany).fill(""));
  },
);

/** The ask arrives through the reader's own choices page — the same journey
 * the asking-to-be-left-alone story proves — so this story's Given exercises
 * the one mechanism a reader really has. */
const asksNotToHear = async (): Promise<void> => {
  await asksNotToHearAboutPromotions(theOneWhoAsked());
};

Given(
  "{string} has booked onto {string} for day {int}",
  function (
    this: TicketsWorld,
    who: string,
    listingName: string,
    day: number,
  ): Promise<void> {
    return personBooksDays(this, who, listingName, day, 1);
  },
);

Given(
  "{string} has booked onto {string} from day {int} for {int} days",
  function (
    this: TicketsWorld,
    who: string,
    listingName: string,
    firstDay: number,
    days: number,
  ): Promise<void> {
    return personBooksDays(this, who, listingName, firstDay, days);
  },
);

When(
  "the owner writes to {string} on day {int} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    day: number,
    words: string,
  ): Promise<void> {
    return writesToListingDay(this, listingName, day, message(words, false));
  },
);

Then(
  "it was written to {string}",
  function (this: TicketsWorld, who: string): void {
    expect(addressesWrittenTo(this)).toContain(addressOf(who));
  },
);

Then(
  "nothing was written to {string}",
  function (this: TicketsWorld, who: string): void {
    expect(addressesWrittenTo(this)).not.toContain(addressOf(who));
  },
);

Given("one of them has asked not to hear about promotions", asksNotToHear);

Given("they have asked not to hear about promotions", asksNotToHear);

const message = (words: string, marketing: boolean): MessageWritten => ({
  body: words,
  marketing,
  subject: "About your booking",
});

When(
  "the owner writes to {string} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    return writesToListing(this, listingName, message(words, false));
  },
);

Given(
  "the owner has written to {string} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    return writesToListing(this, listingName, message(words, false));
  },
);

When(
  "the owner writes a promotion to {string} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    return writesToListing(this, listingName, message(words, true));
  },
);

Given(
  "the owner has written a promotion to {string} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    return writesToListing(this, listingName, message(words, true));
  },
);

When("the owner sends it", function (this: TicketsWorld): Promise<void> {
  return sendsWhatWasPreviewed(this);
});

Then(
  "the owner is shown the message before it goes",
  function (this: TicketsWorld): void {
    const shown = scenarioBrowser(this).pageText;
    // The words they wrote, under the heading that says this is a preview —
    // not the compose form they came from, which also holds those words.
    expect(shown).toContain(t("bulk_email.message_preview_heading"));
    expect(shown).toContain(wordsTheyWrote(this));
  },
);

Then(
  "the owner is shown that it would reach {int} person/people",
  function (this: TicketsWorld, howMany: number): void {
    expect(scenarioBrowser(this).pageText).toContain(`(${howMany} recipient`);
  },
);

Then(
  "the site offers to send it for them",
  function (this: TicketsWorld): void {
    expect(siteOffersToSend(this)).toBe(true);
  },
);

Then(
  "the site does not offer to send it for them",
  function (this: TicketsWorld): void {
    expect(siteOffersToSend(this)).toBe(false);
  },
);

Then(
  "the owner is still offered a draft to send themselves",
  function (this: TicketsWorld): void {
    expect(previewOffersADraftToSendThemselves(this)).toBe(true);
  },
);

Then(
  "the owner is told sending is switched off",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).pageText).toContain(
      t("bulk_email.sending_disabled"),
    );
  },
);

Then(
  "the owner is told it went to {int} people",
  function (this: TicketsWorld, howMany: number): void {
    const told = whatTheyWereTold(this, ORGANISER);
    expect(told).toContain(`${howMany} recipient`);
    // Through their own provider, rather than by some other route.
    expect(told).toContain("Resend");
  },
);

Then(
  "it was written to everyone who booked onto {string}",
  function (this: TicketsWorld, listingName: string): void {
    expect(addressesWrittenTo(this).toSorted()).toEqual(
      bookedOnto(this, listingName).toSorted(),
    );
  },
);

Then(
  "the owner is told {int} person will be left out",
  function (this: TicketsWorld, howMany: number): void {
    expect(scenarioBrowser(this).pageText).toContain(
      `${howMany} ${t("bulk_email.unsubscribed_skipped")}`,
    );
  },
);

Then(
  "it was written to everyone who booked onto {string} but the one who asked",
  function (this: TicketsWorld, listingName: string): void {
    // Both halves: the one who asked was left out, and everyone else still
    // heard. Counting the sends would pass just as well if the wrong person
    // were dropped.
    expect(addressesWrittenTo(this).toSorted()).toEqual(
      bookedOnto(this, listingName)
        .filter((email) => email !== theOneWhoAsked())
        .toSorted(),
    );
  },
);

Then(
  "the owner is told everyone has asked not to hear",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("bulk_email.all_unsubscribed"),
    );
  },
);

Then("nothing was written to anybody", function (this: TicketsWorld): void {
  // The provider was never asked at all. Reading the addresses instead would
  // let a send that went out carrying nothing pass as a refusal.
  expect(timesTheProviderWasAsked(this)).toBe(0);
});

Then(
  "{string} offers a way to write to the people who booked",
  async function (this: TicketsWorld, listingName: string): Promise<void> {
    expect(await listingOffersEmailAction(this, listingName)).toBe(true);
  },
);

Then(
  "{string} offers no way to write to the people who booked",
  async function (this: TicketsWorld, listingName: string): Promise<void> {
    expect(await listingOffersEmailAction(this, listingName)).toBe(false);
  },
);
