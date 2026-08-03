// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import { ownerLastTold } from "#test/specs/support/buyer-questions.ts";
import {
  newsLinkOfferedOnFrontPage,
  ownerPostsNews,
  ownerTakesDownNews,
  visitorFollowsNewsLink,
  visitorOnNewsPage,
} from "#test/specs/support/news.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

When(
  "the owner posts news called {string} saying {string}",
  function (this: TicketsWorld, name: string, words: string): Promise<void> {
    return ownerPostsNews(this, name, words);
  },
);

Given(
  "the owner has posted news called {string}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return ownerPostsNews(this, name, "Come along and see.");
  },
);

Then(
  "the owner is told the news post was created",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("News post created");
  },
);

const newsPageReads = async (words: string): Promise<void> => {
  const read = await visitorOnNewsPage();
  expect(read.answered).toBe(200);
  expect(read.said).toContain(words);
};

Then(
  "a visitor on the news page reads {string}",
  function (this: TicketsWorld, words: string): Promise<void> {
    return newsPageReads(words);
  },
);

Then(
  "a visitor on the news page still reads {string}",
  function (this: TicketsWorld, words: string): Promise<void> {
    return newsPageReads(words);
  },
);

Then(
  "a visitor following {string} from the news page reads {string}",
  async function (this: TicketsWorld, name: string, words: string) {
    const read = await visitorFollowsNewsLink(name);
    expect(read.answered).toBe(200);
    expect(read.said).toContain(words);
  },
);

Then(
  "a visitor asking for the news page finds nothing there",
  async function (this: TicketsWorld): Promise<void> {
    expect((await visitorOnNewsPage()).answered).toBe(404);
  },
);

Then(
  "a visitor on the front page is offered a News link",
  async function (this: TicketsWorld): Promise<void> {
    expect(await newsLinkOfferedOnFrontPage()).toBe(true);
  },
);

Then(
  "a visitor on the front page is offered no News link",
  async function (this: TicketsWorld): Promise<void> {
    expect(await newsLinkOfferedOnFrontPage()).toBe(false);
  },
);

When(
  "the owner tries to take down {string} typing {string}",
  async function (this: TicketsWorld, name: string, typed: string) {
    keepWhatTheyWereTold(
      this,
      ORGANISER,
      await ownerTakesDownNews(this, name, typed),
    );
  },
);

When(
  "the owner takes down {string} typing its exact name",
  async function (this: TicketsWorld, name: string): Promise<void> {
    keepWhatTheyWereTold(
      this,
      ORGANISER,
      await ownerTakesDownNews(this, name, name),
    );
  },
);

Then(
  "the owner is told the post name does not match",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain(
      "Post name does not match. Please type the exact post name to confirm deletion.",
    );
  },
);

Then(
  "the owner is told the news post was deleted",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("News post deleted");
  },
);
