// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { addPageItem } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import {
  browserSeenBy,
  CUSTOMER,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import { combinedPath } from "#test/specs/support/sales-pages.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The page the owner wrote, found by the name the story gave it. */
const pageCalled = async (name: string) => {
  const page = (await sitePages.getAll()).find((page) => page.name === name);
  if (!page) throw new Error(`the story wrote no page called ${name}`);
  return page;
};

Given(
  "the owner has put the {word} and the {word} on the {word} page",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    pageName: string,
  ): Promise<void> {
    const page = await pageCalled(pageName);
    for (const name of [first, second]) {
      await addPageItem(page.id, "listing", listingNamed(this, name).id);
    }
  },
);

When(
  "a customer opens the booking page the {word} is sold from",
  async function (this: TicketsWorld, name: string): Promise<void> {
    rememberBrowser(
      this,
      CUSTOMER,
      await openAsNewcomer(`/ticket/${listingNamed(this, name).slug}`),
    );
  },
);

When(
  "a customer opens one booking for the {word} and the {word} together",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
  ): Promise<void> {
    const lines = [
      { listing: listingNamed(this, first) },
      { listing: listingNamed(this, second) },
    ];
    rememberBrowser(this, CUSTOMER, await openAsNewcomer(combinedPath(lines)));
  },
);

/** The page the customer last looked at. */
const customerPage = (world: TicketsWorld): TestBrowser =>
  browserSeenBy(world, CUSTOMER);

Then(
  "the menu shows the {word} page's own list",
  function (this: TicketsWorld, pageName: string): void {
    expect(customerPage(this).currentHtml).toContain(
      `aria-label="${pageName}"`,
    );
  },
);

Then(
  "the menu shows no {word} page's own list",
  function (this: TicketsWorld, pageName: string): void {
    expect(customerPage(this).currentHtml).not.toContain(
      `aria-label="${pageName}"`,
    );
  },
);

Then(
  "the {word} is marked as the place they are",
  function (this: TicketsWorld, name: string): void {
    expect(customerPage(this).currentHtml).toContain(
      `<a class="active" href="/ticket/${listingNamed(this, name).slug}">`,
    );
  },
);

Then(
  "no menu entry is marked as the place they are",
  function (this: TicketsWorld): void {
    expect(customerPage(this).currentHtml).not.toContain(
      'class="active" href=',
    );
  },
);

Then(
  "the {word} is offered beside it",
  function (this: TicketsWorld, name: string): void {
    expect(customerPage(this).currentHtml).toContain(
      `href="/ticket/${listingNamed(this, name).slug}"`,
    );
  },
);
