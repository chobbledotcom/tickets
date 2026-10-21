// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  newcomerReading,
  openAsNewcomer,
  organiserPressesOnPage,
} from "#test/specs/support/browser.ts";
import {
  ownerTurnsOrderPageOn,
  ownerWritesContactPage,
  ownerWritesHomepage,
} from "#test/specs/support/front-pages.ts";
import {
  imageNamed,
  ownerHasImageInLibrary,
} from "#test/specs/support/images.ts";
import {
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import { newsLinkTo, ownerPostsNews } from "#test/specs/support/news.ts";
import { openBookingPage } from "#test/specs/support/public-booking.ts";
import {
  ownerWritesPage,
  ownerWritesPages,
} from "#test/specs/support/site-pages.ts";
import {
  footerHtml,
  sitePictureTag,
  textWithSitePicture,
} from "#test/specs/support/site-pictures.ts";
import { openTicket } from "#test/specs/support/tickets.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The page at one address shows the story's picture, and no reference. */
const visitorSeesPictureAt = async (
  world: TicketsWorld,
  path: string,
): Promise<void> => {
  const browser = await openAsNewcomer(path);
  expect(browser.currentHtml).toContain(sitePictureTag(world));
  expect(browser.currentHtml).not.toContain("img#");
};

/** The story's picture shows inside this page's site footer, and no
 * unresolved reference shows anywhere on the page. */
const expectFooterPicture = (world: TicketsWorld, html: string): void => {
  expect(footerHtml(html)).toContain(sitePictureTag(world));
  expect(html).not.toContain("img#");
};

/** The page somebody opened shows the story's picture in its site footer,
 * and the site answered it with the status the story expects. */
const footerShowsPicture = (
  world: TicketsWorld,
  answered: number,
  browser: TestBrowser,
): void => {
  expect(browser.answered).toBe(answered);
  expectFooterPicture(world, browser.currentHtml);
};

Given(
  "the owner has uploaded a picture called {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await ownerHasImageInLibrary(this, name);
    const image = await imageNamed(name);
    this.siteImage = { alt: name, filename: image.filename, id: image.id };
  },
);

When(
  "the owner writes a homepage called {string} with the picture in it",
  function (this: TicketsWorld, title: string): Promise<void> {
    return ownerWritesHomepage(this, title, textWithSitePicture(this));
  },
);

When(
  "the owner writes a homepage naming a picture that was never uploaded",
  function (this: TicketsWorld): Promise<void> {
    return ownerWritesHomepage(
      this,
      "Riverbank Pottery",
      "Have a look. ![Ghost](img#424242)",
    );
  },
);

When(
  "the owner writes a contact page with the picture in it",
  function (this: TicketsWorld): Promise<void> {
    return ownerWritesContactPage(this, textWithSitePicture(this));
  },
);

When(
  "the owner turns the order page on, introducing it with the picture in it",
  function (this: TicketsWorld): Promise<void> {
    return ownerTurnsOrderPageOn(this, textWithSitePicture(this));
  },
);

When(
  "the owner posts news called {string} with the picture in it",
  function (this: TicketsWorld, name: string): Promise<void> {
    return ownerPostsNews(this, name, textWithSitePicture(this));
  },
);

When(
  "the owner writes a page called {word} at {string} with the picture in it",
  async function (
    this: TicketsWorld,
    name: string,
    address: string,
  ): Promise<void> {
    await ownerWritesPages(this);
    await ownerWritesPage(this, name, address, textWithSitePicture(this));
  },
);

Given(
  "the site sells a {word} with the picture in its description",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await putsPlainThingOnSale(this, name, {
      description: textWithSitePicture(this),
    });
  },
);

/** The owner saves the terms through the settings form that renders the
 * field, so a broken form fails the story rather than a direct write. */
const ownerWritesTerms = (world: TicketsWorld, words: string): Promise<void> =>
  organiserPressesOnPage(world, "/admin/settings", "Save Terms", {
    terms_and_conditions: words,
  });

When(
  "the owner writes the terms saying {string}",
  function (this: TicketsWorld, words: string): Promise<void> {
    return ownerWritesTerms(this, words);
  },
);

When(
  "the owner writes the terms with the picture in it",
  function (this: TicketsWorld): Promise<void> {
    return ownerWritesTerms(this, textWithSitePicture(this));
  },
);

When(
  "the owner saves a site footer with the picture in it",
  function (this: TicketsWorld): Promise<void> {
    return organiserPressesOnPage(this, "/admin/settings", "Save site footer", {
      site_footer: textWithSitePicture(this),
    });
  },
);

Then(
  "a visitor on the front page sees the picture",
  function (this: TicketsWorld): Promise<void> {
    return visitorSeesPictureAt(this, "/");
  },
);

Then(
  "a visitor on the contact page sees the picture",
  function (this: TicketsWorld): Promise<void> {
    return visitorSeesPictureAt(this, "/contact");
  },
);

Then(
  "a visitor on the order page sees the picture",
  function (this: TicketsWorld): Promise<void> {
    return visitorSeesPictureAt(this, "/order");
  },
);

Then(
  "a visitor on the terms page sees the picture",
  function (this: TicketsWorld): Promise<void> {
    return visitorSeesPictureAt(this, "/terms");
  },
);

Then(
  "the list shows the picture",
  function (this: TicketsWorld): Promise<void> {
    return visitorSeesPictureAt(this, "/listings");
  },
);

Then(
  "a visitor reading {string} sees the picture",
  function (this: TicketsWorld, address: string): Promise<void> {
    return visitorSeesPictureAt(this, `/page/${address}`);
  },
);

Then(
  "a visitor following {string} from the news page sees the picture",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await visitorSeesPictureAt(this, await newsLinkTo(name));
  },
);

Then(
  "a visitor on the front page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/"));
  },
);

Then(
  "a visitor asking for a page nobody wrote still sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 404, await openAsNewcomer("/page/no-such-page"));
  },
);

Then(
  "a visitor asking for a page nobody wrote is told the page does not exist",
  async function (this: TicketsWorld): Promise<void> {
    const { answered, said } = await newcomerReading("/page/no-such-page");
    expect(answered).toBe(404);
    expect(said).toContain(t("public.not_found.heading"));
  },
);

Then(
  "a visitor on the list sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/listings"));
  },
);

Then(
  "a visitor on the contact page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/contact"));
  },
);

Then(
  "a visitor on the terms page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/terms"));
  },
);

Then(
  "a visitor on the order page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/order"));
  },
);

Then(
  "a visitor on the news page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/news"));
  },
);

Then(
  "a visitor following the {string} post from the news page sees the picture in the footer",
  async function (this: TicketsWorld, name: string): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer(await newsLinkTo(name)));
  },
);

Then(
  "a visitor reading {string} sees the picture in the footer",
  async function (this: TicketsWorld, address: string): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer(`/page/${address}`));
  },
);

Then(
  "a visitor on the {word}'s booking page sees the picture in the footer",
  async function (this: TicketsWorld, name: string): Promise<void> {
    footerShowsPicture(
      this,
      200,
      await openBookingPage(listingNamed(this, name)),
    );
  },
);

Then(
  "a visitor opening the ticket they were given sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openTicket(this));
  },
);

Then(
  "a visitor opening the {word}'s booking page inside another website sees no site footer",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const listing = listingNamed(this, name);
    const browser = await openAsNewcomer(`/ticket/${listing.slug}?iframe=true`);
    expect(browser.answered).toBe(200);
    expect(browser.currentHtml).toContain(listing.name);
    expect(browser.currentHtml).toContain("Continue");
    expect(browser.currentHtml).not.toContain('<footer class="site-footer">');
    expect(browser.currentHtml).not.toContain(sitePictureTag(this));
  },
);

Then(
  "the front page keeps the picture's describing words",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    expect(browser.currentHtml).toContain('<img src="" alt="Ghost">');
  },
);

Then(
  "the front page shows no picture at all",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    expect(browser.currentHtml).not.toContain('<img src="/image/');
  },
);
