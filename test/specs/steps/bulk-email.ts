/** An owner writes to the people who booked, checks it over, and sends it. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { ORGANISER, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  addressesWrittenTo,
  asksNotToHearAboutPromotions,
  bookedOnto,
  listingOffersEmailAction,
  type MessageWritten,
  ownerHasAnEmailProvider,
  peopleBookOnto,
  previewOffersASend,
  sendsWhatWasPreviewed,
  watchWhatIsSent,
  wordsTheyWrote,
  writesToListing,
} from "#test/specs/support/bulk-email.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The addresses a story gives the people it books on. Kept here so every
 * scenario books the same people and a later step can name one of them. */
const BOOKERS = ["first@example.com", "second@example.com"];

const bookersFor = (howMany: number): string[] => BOOKERS.slice(0, howMany);

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
    // Without a provider set up, nothing reaches the outside world — but the
    // watch still has to be standing by, or a send that should have been
    // refused would go out to a real address.
    if (!this.messagesOut) watchWhatIsSent(this);
    return peopleBookOnto(this, listingName, bookersFor(howMany));
  },
);

Given(
  "{int} person/people have/has booked onto {string} leaving no address",
  function (
    this: TicketsWorld,
    howMany: number,
    listingName: string,
  ): Promise<void> {
    if (!this.messagesOut) watchWhatIsSent(this);
    return peopleBookOnto(this, listingName, Array(howMany).fill(""));
  },
);

/** The first person a story booked is the one it unsubscribes, so "one of them"
 * and "they" mean the same person however many were booked. */
const theOneWhoAsked = (): string => BOOKERS[0]!;

const asksNotToHear = (): Promise<void> =>
  asksNotToHearAboutPromotions(theOneWhoAsked());

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
  "the owner is shown that it would reach {int} people",
  function (this: TicketsWorld, howMany: number): void {
    expect(scenarioBrowser(this).pageText).toContain(`(${howMany} recipient`);
  },
);

Then(
  "the owner is offered a way to send it",
  function (this: TicketsWorld): void {
    expect(previewOffersASend(this)).toBe(true);
  },
);

Then(
  "the owner is offered no way to send it",
  function (this: TicketsWorld): void {
    expect(previewOffersASend(this)).toBe(false);
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
  expect(addressesWrittenTo(this)).toEqual([]);
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
