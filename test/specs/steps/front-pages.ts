// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  ownerTurnsOrderPageOn,
  ownerWritesContactPage,
  ownerWritesHomepage,
  visitorOnFrontPage,
} from "#test/specs/support/front-pages.ts";
import { ownerLastTold, type TicketsWorld } from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

When(
  "the owner writes a homepage called {string} saying {string}",
  function (this: TicketsWorld, title: string, welcome: string): Promise<void> {
    return ownerWritesHomepage(this, title, welcome);
  },
);

Then(
  "the owner is told the homepage saved",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Homepage updated");
  },
);

When(
  "the owner writes a contact page saying {string}",
  function (this: TicketsWorld, text: string): Promise<void> {
    return ownerWritesContactPage(this, text);
  },
);

Then(
  "the owner is told the contact page saved",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Contact page updated");
  },
);

Given("the public site is on", function (this: TicketsWorld): Promise<void> {
  return enablePublicSite();
});

Then(
  "a visitor asking for the order page finds nothing there",
  async function (this: TicketsWorld): Promise<void> {
    expect((await visitorOnFrontPage("/order")).answered).toBe(404);
  },
);

When(
  "the owner turns the order page on, introducing it with {string}",
  function (this: TicketsWorld, intro: string): Promise<void> {
    return ownerTurnsOrderPageOn(this, intro);
  },
);

Then(
  "a visitor on the front page reads {string}",
  async function (this: TicketsWorld, words: string): Promise<void> {
    const read = await visitorOnFrontPage("/");
    expect(read.answered).toBe(200);
    expect(read.said).toContain(words);
  },
);

Then(
  "a visitor on the contact page reads {string}",
  async function (this: TicketsWorld, words: string): Promise<void> {
    const read = await visitorOnFrontPage("/contact");
    expect(read.answered).toBe(200);
    expect(read.said).toContain(words);
  },
);

Then(
  "a visitor on the order page reads {string}",
  async function (this: TicketsWorld, words: string): Promise<void> {
    const read = await visitorOnFrontPage("/order");
    expect(read.answered).toBe(200);
    expect(read.said).toContain(words);
  },
);
