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
import { customerOpensBundlePage } from "#test/specs/support/bundles.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import { combinedPath } from "#test/specs/support/sales-pages.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import type { SitePageItemType } from "#types";

// jscpd:ignore-end

/** The page the owner wrote, found by the name the story gave it. */
const pageCalled = async (name: string) => {
  const page = (await sitePages.getAll()).find((page) => page.name === name);
  if (!page) throw new Error(`the story wrote no page called ${name}`);
  return page;
};

/** One thing a page carries, and the kind of slot it takes. */
type PageEntry = { id: number; type: SitePageItemType };

const putOnPage = async (
  pageName: string,
  entries: PageEntry[],
): Promise<void> => {
  const page = await pageCalled(pageName);
  for (const entry of entries) {
    await addPageItem(page.id, entry.type, entry.id);
  }
};

const listingEntry = (world: TicketsWorld, name: string): PageEntry => ({
  id: listingNamed(world, name).id,
  type: "listing",
});

Given(
  "the owner has put the {word} and the {word} on the {word} page",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    pageName: string,
  ): Promise<void> {
    await putOnPage(pageName, [
      listingEntry(this, first),
      listingEntry(this, second),
    ]);
  },
);

Given(
  "the owner has put the {word} on the {word} page",
  async function (
    this: TicketsWorld,
    name: string,
    pageName: string,
  ): Promise<void> {
    await putOnPage(pageName, [listingEntry(this, name)]);
  },
);

Given(
  "the owner has put the group called {word} on the {word} page",
  async function (
    this: TicketsWorld,
    groupName: string,
    pageName: string,
  ): Promise<void> {
    await putOnPage(pageName, [
      { id: this.things.require("bundle", groupName).id, type: "group" },
    ]);
  },
);

Given(
  "the owner has put the {word} page inside the {word} page",
  async function (
    this: TicketsWorld,
    childName: string,
    parentName: string,
  ): Promise<void> {
    await putOnPage(parentName, [
      { id: (await pageCalled(childName)).id, type: "page" },
    ]);
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
  "a customer opens the {word} group's booking page",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    rememberBrowser(
      this,
      CUSTOMER,
      await customerOpensBundlePage(this, groupName),
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
    const browser = new TestBrowser();
    // A combo page that did not serve would make every later "nothing shows"
    // assertion true by accident, so the visit itself has to reach the form.
    expect(await browser.visit(combinedPath(lines))).toBe(200);
    rememberBrowser(this, CUSTOMER, browser);
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

Then(
  "the {word} page is marked as the place they are",
  async function (this: TicketsWorld, pageName: string): Promise<void> {
    const page = await pageCalled(pageName);
    expect(customerPage(this).currentHtml).toContain(
      `<a class="active" href="/page/${page.slug}">`,
    );
  },
);

Then(
  "the menu still offers the {word} page",
  async function (this: TicketsWorld, pageName: string): Promise<void> {
    const page = await pageCalled(pageName);
    expect(customerPage(this).currentHtml).toContain(
      `href="/page/${page.slug}"`,
    );
  },
);

Then(
  "the {word} is not marked as the place they are",
  function (this: TicketsWorld, name: string): void {
    expect(customerPage(this).currentHtml).not.toContain(
      `<a class="active" href="/ticket/${listingNamed(this, name).slug}">`,
    );
  },
);

Then(
  "the {word} group is marked as the place they are",
  function (this: TicketsWorld, groupName: string): void {
    const group = this.things.require("bundle", groupName);
    expect(customerPage(this).currentHtml).toContain(
      `<a class="active" href="/ticket/${group.slug}">`,
    );
  },
);

Then(
  "the booking form offers the {word} and the {word}",
  function (this: TicketsWorld, first: string, second: string): void {
    const html = customerPage(this).currentHtml;
    for (const name of [first, second]) {
      expect(html).toContain(`name="quantity_${listingNamed(this, name).id}"`);
    }
  },
);
