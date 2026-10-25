// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
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
import {
  ownerPostsNews,
  visitorFollowsNewsLink,
} from "#test/specs/support/news.ts";
import { groupHolding } from "#test/specs/support/public-list.ts";
import {
  ownerWritesPage,
  ownerWritesPages,
  whatOwnerWasTold,
  wordsOnlyOn,
} from "#test/specs/support/site-pages.ts";
import {
  expectFooterPicture,
  footerShowsPicture,
  readShowsProsePicture,
  sitePictureTag,
  textWithSitePicture,
  wordsWithSitePicture,
} from "#test/specs/support/site-pictures.ts";
import { openTicket } from "#test/specs/support/tickets.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The page at one address shows the story's picture, and no reference. */
const visitorSeesPictureAt = async (
  world: TicketsWorld,
  path: string,
): Promise<void> => {
  const browser = await openAsNewcomer(path);
  assertStringIncludes(browser.currentHtml, sitePictureTag(world));
  assert(!browser.currentHtml.includes("img#"));
};

/** A page the footer story reads beside its own words: where it lives, the
 * words it carries, and how the owner writes them. The words prove the
 * visitor read that page itself, not a page that merely answers. */
type StoryPage = {
  path: string;
  words: string;
  write: (world: TicketsWorld, words: string) => Promise<void>;
};

const STORY_PAGES: Record<string, StoryPage> = {
  "contact page": {
    path: "/contact",
    words: "Reach the studio on market days.",
    write: (world, words) => ownerWritesContactPage(world, words),
  },
  "order page": {
    path: "/order",
    words: "Everything on one page.",
    write: (world, words) => ownerTurnsOrderPageOn(world, words),
  },
  "page the owner wrote": {
    path: "/page/how-to-find-us",
    words: wordsOnlyOn("Directions"),
    write: async (world) => {
      await ownerWritesPages(world);
      await ownerWritesPage(world, "Directions", "how-to-find-us");
      assertStringIncludes(whatOwnerWasTold(world), "Page created");
    },
  },
  "terms page": {
    path: "/terms",
    words: "Be kind to the kilns.",
    write: (world, words) => ownerWritesTerms(world, words),
  },
};

/** The page the story named. A story that names a page the story does not
 * know fails here rather than reading some other page. */
const storyPage = (page: string): StoryPage => {
  const known = STORY_PAGES[page];
  if (known === undefined) {
    throw new Error(`The story does not know the page "${page}".`);
  }
  return known;
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

/** The owner saves the terms through the settings form that renders the
 * field, so a broken form fails the story rather than a direct write. */
const ownerWritesTerms = (world: TicketsWorld, words: string): Promise<void> =>
  organiserPressesOnPage(world, "/admin/settings", "Save Terms", {
    terms_and_conditions: words,
  });

When(
  "the owner writes the terms with the picture in it",
  function (this: TicketsWorld): Promise<void> {
    return ownerWritesTerms(this, textWithSitePicture(this));
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
    await ownerWritesPage(
      this,
      name,
      address,
      wordsWithSitePicture(this, wordsOnlyOn(name)),
    );
  },
);

Given(
  "the owner has written the {string} with their own words",
  async function (this: TicketsWorld, page: string): Promise<void> {
    const known = storyPage(page);
    await known.write(this, known.words);
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

When(
  "the owner posts news called {string} saying {string} with the picture in its words",
  function (this: TicketsWorld, name: string, words: string): Promise<void> {
    return ownerPostsNews(this, name, wordsWithSitePicture(this, words));
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
  "a visitor reading {string} is shown {word} and sees the picture",
  async function (
    this: TicketsWorld,
    address: string,
    name: string,
  ): Promise<void> {
    readShowsProsePicture(
      this,
      await openAsNewcomer(`/page/${address}`),
      wordsOnlyOn(name),
    );
  },
);

Then(
  "a visitor following {string} from the news page reads {string} and sees the picture",
  async function (
    this: TicketsWorld,
    name: string,
    words: string,
  ): Promise<void> {
    readShowsProsePicture(this, await visitorFollowsNewsLink(name), words);
  },
);

Then(
  "a visitor on the front page sees the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    footerShowsPicture(this, 200, await openAsNewcomer("/"));
  },
);

Then(
  "a visitor on the {string} sees the picture in the footer",
  async function (this: TicketsWorld, page: string): Promise<void> {
    const known = storyPage(page);
    const browser = await openAsNewcomer(known.path);
    assertStringIncludes(browser.currentHtml, known.words);
    footerShowsPicture(this, 200, browser);
  },
);

Then(
  "the page they were shown shows the picture in the footer",
  function (this: TicketsWorld): void {
    expectFooterPicture(
      this,
      requiredWorldValue(
        this.returnPageHtml,
        "the page the customer was shown",
      ),
    );
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
    assertStringIncludes(said, t("public.not_found.heading"));
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
    assertStringIncludes(browser.currentHtml, listing.name);
    assertStringIncludes(browser.currentHtml, "Continue");
    assert(!browser.currentHtml.includes('<footer class="site-footer">'));
    assert(!browser.currentHtml.includes(sitePictureTag(this)));
  },
);

Then(
  "the front page keeps the picture's describing words",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    assertStringIncludes(browser.currentHtml, '<img src="" alt="Ghost">');
  },
);

Then(
  "the front page shows no picture at all",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAsNewcomer("/");
    assert(!browser.currentHtml.includes('<img src="/image/'));
  },
);

Given(
  "a {word} group holding a {word} with the picture in its words",
  function (this: TicketsWorld, group: string, part: string): Promise<void> {
    return groupHolding(this, group, [{ name: part, state: "on sale" }], {
      describedAs: textWithSitePicture(this),
    });
  },
);

When(
  "the site sells a {word} with the picture in its description",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await putsPlainThingOnSale(this, name, {
      description: textWithSitePicture(this),
    });
  },
);

Then(
  "a visitor on the list reads the {word} and sees the picture",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openAsNewcomer("/listings");
    assertStringIncludes(browser.currentHtml, `<h2>${name}</h2>`);
    assertStringIncludes(browser.currentHtml, sitePictureTag(this));
    assert(!browser.currentHtml.includes("img#"));
  },
);
