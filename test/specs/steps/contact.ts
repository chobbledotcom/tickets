// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import {
  ADDRESS_ON_OWNERS_HOST,
  anEmailWasSent,
  COULD_NOT_CHECK,
  contactPageAnswers,
  messageSent,
  messagesAreWorking,
  ownerTakesAway,
  SENT,
  SPOOF_WARNING,
  sendingIsBroken,
  spamCheckWasAsked,
  spamProtectionIsOn,
  visitorIsOfferedAForm,
  visitorWrites,
  whatVisitorWasTold,
} from "#test/specs/support/contact.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { CONTACT_OWNER_EMAIL } from "#test-utils/settings.ts";

// jscpd:ignore-end

Given("the owner takes messages", function (this: TicketsWorld): Promise<void> {
  return messagesAreWorking(this);
});

Given(
  "the owner takes messages, but sending is broken",
  function (this: TicketsWorld): Promise<void> {
    return sendingIsBroken(this);
  },
);

Given(
  "the owner takes messages, with spam protection switched on",
  function (this: TicketsWorld): Promise<void> {
    return spamProtectionIsOn(this);
  },
);

When(
  "the owner takes away {word} {word}",
  async function (
    this: TicketsWorld,
    whose: string,
    part: string,
  ): Promise<void> {
    await ownerTakesAway(`${whose} ${part}`);
  },
);

Then(
  "a visitor is offered a form to write in",
  async function (this: TicketsWorld): Promise<void> {
    expect(await visitorIsOfferedAForm()).toBe(true);
  },
);

Then(
  "a visitor is offered no form",
  async function (this: TicketsWorld): Promise<void> {
    // Either the page is gone altogether or it is there without a form. Both
    // mean the same thing to a visitor: nowhere to write.
    const answered = await contactPageAnswers();
    if (answered === 200) expect(await visitorIsOfferedAForm()).toBe(false);
    else expect(answered).toBe(404);
  },
);

When(
  "a visitor writes in from {string}",
  async function (this: TicketsWorld, from: string): Promise<void> {
    await visitorWrites(this, from, "Do you take dogs?");
  },
);

When(
  "a visitor writes in claiming the owner's own address",
  async function (this: TicketsWorld): Promise<void> {
    await visitorWrites(this, ADDRESS_ON_OWNERS_HOST, "Do you take dogs?");
  },
);

Then(
  "a reply to it would go to the site's own address",
  function (this: TicketsWorld): void {
    // The exact address, not merely "not the claimed one" — a message with no
    // reply address at all would satisfy that and leave the owner stuck.
    expect(messageSent(this).reply_to).toBe(CONTACT_OWNER_EMAIL);
  },
);

Then(
  "the owner is warned the sender may be pretending",
  function (this: TicketsWorld): void {
    expect(messageSent(this).html).toContain(SPOOF_WARNING);
  },
);

Then("the visitor is told it was sent", function (this: TicketsWorld): void {
  expect(whatVisitorWasTold(this)).toContain(SENT);
});

/** Being turned away, whichever way the site words it. Both wordings are read
 * from production, and both must also fail to say the message went — being
 * told "sent" alongside an apology would still leave the visitor waiting. */
const expectTurnedAway = function (this: TicketsWorld, wording: string): void {
  const told = whatVisitorWasTold(this);
  expect(told).toContain(wording);
  expect(told).not.toContain(SENT);
};

Then("the visitor is told it could not be sent", function (this: TicketsWorld) {
  expectTurnedAway.call(this, MESSAGE_SEND_FAILED);
});

Then(
  "the visitor is told it could not be checked",
  function (this: TicketsWorld) {
    expectTurnedAway.call(this, COULD_NOT_CHECK);
  },
);

Then("the message reaches the owner", function (this: TicketsWorld): void {
  expect(messageSent(this).to).toEqual([CONTACT_OWNER_EMAIL]);
});

Then("nothing reaches the owner", function (this: TicketsWorld): void {
  expect(anEmailWasSent(this)).toBe(false);
});

Then(
  "the spam checker was never even asked",
  function (this: TicketsWorld): void {
    // A message with no solved puzzle is turned down before anybody is asked,
    // so a site that started asking about empty answers would fail here.
    expect(spamCheckWasAsked(this)).toBe(false);
  },
);

Then(
  "a reply to it would go to {string}",
  function (this: TicketsWorld, address: string): void {
    expect(messageSent(this).reply_to).toBe(address);
  },
);
