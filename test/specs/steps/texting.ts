// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  gatewayIsSetUp,
  gatewayIsSwitchedOff,
  gatewayWillAnswer,
  historyShownTo,
  messagesQueued,
  organiserOpensSomebodysTexts,
  organiserOpensTheTextsPage,
  organiserTexts,
  phoneOf,
  recordAgainstPhone,
  somebodyBooks,
  textingCopy,
} from "#test/specs/support/texting.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { says } from "#test-utils/says.ts";

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
  function (this: TicketsWorld, who: string): Promise<void> {
    return organiserOpensSomebodysTexts(this, who);
  },
);

When(
  "the organiser texts {word} {string}",
  function (this: TicketsWorld, who: string, message: string): Promise<void> {
    return organiserTexts(this, who, message);
  },
);

Then(
  "the page says {int} messages are waiting to go",
  async function (this: TicketsWorld, waiting: number): Promise<void> {
    says(
      whatTheyWereTold(this, ORGANISER),
      await textingCopy("sms.queue.awaiting", { count: waiting }),
    );
  },
);

Then(
  "there is no way to write a text",
  async function (this: TicketsWorld): Promise<void> {
    assert(
      !whatTheyWereTold(this, ORGANISER).includes(
        await textingCopy("sms.contact.compose_heading"),
      ),
    );
  },
);

Then(
  "the page says the gateway is not set up",
  async function (this: TicketsWorld): Promise<void> {
    says(
      whatTheyWereTold(this, ORGANISER),
      await textingCopy("sms.contact.not_configured"),
    );
  },
);

Then(
  "the page says there is no number on file",
  async function (this: TicketsWorld): Promise<void> {
    says(
      whatTheyWereTold(this, ORGANISER),
      await textingCopy("sms.contact.no_phone"),
    );
  },
);

Then(
  "the page names {word} and the number she gave",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const page = whatTheyWereTold(this, ORGANISER);
    says(page, who);
    says(page, phoneOf(this, who));
    says(page, await textingCopy("sms.contact.compose_heading"));
  },
);

Then(
  "the organiser is told the text was queued",
  function (this: TicketsWorld): void {
    says(whatTheyWereTold(this, ORGANISER), "Text message queued");
  },
);

Then(
  "the organiser is told the text could not be queued",
  function (this: TicketsWorld): void {
    says(whatTheyWereTold(this, ORGANISER), "Message could not be queued");
  },
);

Then(
  "the organiser is told the message cannot be empty",
  function (this: TicketsWorld): void {
    says(whatTheyWereTold(this, ORGANISER), "Message cannot be empty");
  },
);

Then(
  "{word}'s history holds {string}",
  async function (
    this: TicketsWorld,
    who: string,
    message: string,
  ): Promise<void> {
    says(await historyShownTo(this, who), message);
  },
);

Then(
  "nothing has been said to {word}",
  async function (this: TicketsWorld, who: string): Promise<void> {
    says(
      await historyShownTo(this, who),
      await textingCopy("sms.contact.no_messages"),
    );
  },
);

Then(
  "{word}'s history says the text could not be queued",
  async function (this: TicketsWorld, who: string): Promise<void> {
    says(await historyShownTo(this, who), "could not be queued");
  },
);

Then(
  "nothing was queued for {word}",
  async function (this: TicketsWorld, who: string): Promise<void> {
    // The queue itself, not only the log's wording: a message that reached
    // the queue without its success line would otherwise read as nothing.
    expect(await messagesQueued()).toBe(0);
    assert(!(await historyShownTo(this, who)).includes("queued for"));
  },
);

Then(
  "the site counts {int} message(s) against {word}'s phone",
  async function (
    this: TicketsWorld,
    counted: number,
    who: string,
  ): Promise<void> {
    expect((await recordAgainstPhone(this, who)).counted).toBe(counted);
  },
);

Then(
  "the last thing kept against {word}'s phone is {string}",
  async function (
    this: TicketsWorld,
    who: string,
    said: string,
  ): Promise<void> {
    // The count alone would pass on a text the site filed under the wrong
    // words, and those words are what the organiser reads back later.
    expect((await recordAgainstPhone(this, who)).lastSaid).toBe(said);
  },
);
