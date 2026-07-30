// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  answerInListDownload,
  askedQuestion,
  ownerAsksChoiceQuestion,
  ownerAsksWrittenQuestion,
  ownerTakesQuestionDown,
  questionFieldOn,
  questionPageOffersChoices,
  visitorBooksAnswering,
  visitorOpensBooking,
} from "#test/specs/support/buyer-questions.ts";
import { ownerLastTold, type TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the owner asks {word} buyers {string} offering {word} or {word}",
  function (
    this: TicketsWorld,
    listingName: string,
    text: string,
    first: string,
    second: string,
  ): Promise<void> {
    return ownerAsksChoiceQuestion(this, listingName, text, [first, second]);
  },
);

Given(
  "the owner asks {word} buyers to write {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    text: string,
  ): Promise<void> {
    return ownerAsksWrittenQuestion(this, text, listingName);
  },
);

Given(
  "the owner asks buyers to write {string}",
  function (this: TicketsWorld, text: string): Promise<void> {
    return ownerAsksWrittenQuestion(this, text);
  },
);

Then(
  "a visitor booking the {word} is offered {string} with {word} and {word}",
  async function (
    this: TicketsWorld,
    listingName: string,
    text: string,
    first: string,
    second: string,
  ): Promise<void> {
    const browser = await visitorOpensBooking(this, listingName);
    expect(browser.pageText).toContain(text);
    questionFieldOn(this, browser);
    expect(browser.pageText).toContain(first);
    expect(browser.pageText).toContain(second);
  },
);

Then(
  "a visitor booking the {word} is not asked {string}",
  async function (
    this: TicketsWorld,
    listingName: string,
    text: string,
  ): Promise<void> {
    const browser = await visitorOpensBooking(this, listingName);
    expect(browser.pageText).not.toContain(text);
  },
);

When(
  "a visitor books the {word} answering {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    answer: string,
  ): Promise<void> {
    return visitorBooksAnswering(this, listingName, answer);
  },
);

Then(
  "the owner reads {string} against that booking",
  async function (this: TicketsWorld, answer: string): Promise<void> {
    // The question was asked of exactly one listing in these stories, so the
    // booking it produced is on that listing's own list.
    expect(await answerInListDownload(this, "Pottery")).toBe(answer);
  },
);

Then(
  "the owner is offered no way to add answer choices",
  async function (this: TicketsWorld): Promise<void> {
    expect(await questionPageOffersChoices(this)).toBe(false);
  },
);

When(
  "the owner takes the question away, typing {string}",
  function (this: TicketsWorld, typed: string): Promise<void> {
    return ownerTakesQuestionDown(this, typed);
  },
);

Then(
  "the owner is told the question's text does not match",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Question text does not match");
    // Still there to be asked: the page the owner is on is the question's own
    // delete page, which only exists while the question does.
    expect(ownerLastTold(this)).toContain(askedQuestion(this).text);
  },
);

Then(
  "the owner is told the question is deleted",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Question deleted");
  },
);
