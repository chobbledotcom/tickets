// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  gatewayIsSetUp,
  gatewayIsSwitchedOff,
  gatewayWillAnswer,
  historyShownTo,
  messagesCountedAgainstPhone,
  messagesQueued,
  organiserOpensSomebodysTexts,
  organiserOpensTheTextsPage,
  organiserTexts,
  PHONE_GIVEN,
  somebodyBooks,
  textingCopy,
} from "#test/specs/support/texting.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given("the gateway is set up", (): Promise<void> => gatewayIsSetUp());

Given(
  "the gateway is refusing everything",
  function (this: TicketsWorld): void {
    gatewayWillAnswer(this, () => new Response("boom", { status: 500 }));
  },
);

When(
  "the gateway is switched off",
  (): Promise<void> => gatewayIsSwitchedOff(),
);

/** Somebody books, with or without leaving a number. Two steps over one
 * helper, because Cucumber binds by position and a shared body with an
 * optional trailing parameter reports the wrong arity. */
Given(
  "{word} has booked the {word}, giving a phone number",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return somebodyBooks(this, who, listing, true);
  },
);

Given(
  "{word} has booked the {word}, giving no phone number",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return somebodyBooks(this, who, listing, false);
  },
);

When(
  "the organiser opens the text messages page",
  function (this: TicketsWorld): Promise<void> {
    return organiserOpensTheTextsPage(this);
  },
);

When(
  "the organiser opens {word}'s text messages",
  function (this: TicketsWorld, _who: string): Promise<void> {
    return organiserOpensSomebodysTexts(this);
  },
);

When(
  "the organiser texts {word} {string}",
  function (this: TicketsWorld, _who: string, message: string): Promise<void> {
    return organiserTexts(this, message);
  },
);

Then(
  "the page says {int} messages are waiting to go",
  async function (this: TicketsWorld, waiting: number): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await textingCopy("sms.queue.awaiting", { count: waiting }),
    );
  },
);

Then(
  "there is no way to write a text",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).not.toContain(
      await textingCopy("sms.contact.compose_heading"),
    );
  },
);

Then(
  "the page says the gateway is not set up",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await textingCopy("sms.contact.not_configured"),
    );
  },
);

Then(
  "the page says there is no number on file",
  async function (this: TicketsWorld): Promise<void> {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      await textingCopy("sms.contact.no_phone"),
    );
  },
);

Then(
  "the page names {word} and the number she gave",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    expect(page).toContain(who);
    expect(page).toContain(PHONE_GIVEN);
    expect(page).toContain(await textingCopy("sms.contact.compose_heading"));
  },
);

Then(
  "the organiser is told the text was queued",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain("Text message queued");
  },
);

Then(
  "the organiser is told the text could not be queued",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Message could not be queued",
    );
  },
);

Then(
  "the organiser is told the message cannot be empty",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Message cannot be empty",
    );
  },
);

Then(
  "{word}'s history holds {string}",
  function (this: TicketsWorld, _who: string, message: string): void {
    expect(historyShownTo(this)).toContain(message);
  },
);

Then(
  "{word}'s history says the text could not be queued",
  function (this: TicketsWorld, _who: string): void {
    expect(historyShownTo(this)).toContain("could not be queued");
  },
);

Then(
  "nothing was queued for {word}",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    // The queue itself, not only the log's wording: a message that reached
    // the queue without its success line would otherwise read as nothing.
    expect(await messagesQueued()).toBe(0);
    expect(historyShownTo(this)).not.toContain("queued for");
  },
);

Then(
  "the site counts {int} message(s) against {word}'s phone",
  async function (
    this: TicketsWorld,
    counted: number,
    _who: string,
  ): Promise<void> {
    expect(await messagesCountedAgainstPhone()).toBe(counted);
  },
);
