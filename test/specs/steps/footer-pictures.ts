// jscpd:ignore-start

import { Then } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  browserSeenBy,
  CUSTOMER,
  openAsNewcomer,
} from "#test/specs/support/browser.ts";
import { balancePageHtml } from "#test/specs/support/deposits.ts";
import { READER } from "#test/specs/support/email-choices.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  visitorFollowsNewsLink,
  visitorOnNewsPage,
} from "#test/specs/support/news.ts";
import {
  expectFooterPicture,
  footerShowsPicture,
  readShowsFooterPicture,
} from "#test/specs/support/site-pictures.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Then(
  "a visitor on the list sees the {word} and the picture in the footer",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openAsNewcomer("/listings");
    expect(browser.currentHtml).toContain(`<h2>${name}</h2>`);
    footerShowsPicture(this, 200, browser);
  },
);

Then(
  "a visitor on the news page reads {string} and sees the picture in the footer",
  async function (this: TicketsWorld, words: string): Promise<void> {
    readShowsFooterPicture(this, await visitorOnNewsPage(), words);
  },
);

Then(
  "a visitor following {string} from the news page reads {string} and sees the picture in the footer",
  async function (
    this: TicketsWorld,
    name: string,
    words: string,
  ): Promise<void> {
    readShowsFooterPicture(this, await visitorFollowsNewsLink(name), words);
  },
);

Then(
  "a visitor on the {word}'s booking page sees the picture in the footer",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openAsNewcomer(
      `/ticket/${listingNamed(this, name).slug}`,
    );
    expect(browser.currentHtml).toContain(name);
    footerShowsPicture(this, 200, browser);
  },
);

Then(
  "the page they are shown after they pay says their order went through and shows the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    const token = requiredWorldValue(
      this.ticketToken,
      "the link they were given",
    );
    const browser = await openAsNewcomer(`/payment/success?tokens=${token}`);
    expect(browser.currentHtml).toContain(t("payment.success.heading"));
    footerShowsPicture(this, 200, browser);
  },
);

Then(
  "the page their booking landed on shows the picture in the footer",
  function (this: TicketsWorld): void {
    expectFooterPicture(this, browserSeenBy(this, CUSTOMER).currentHtml);
  },
);

Then(
  "their payment link shows the picture in the footer",
  async function (this: TicketsWorld): Promise<void> {
    expectFooterPicture(this, await balancePageHtml(this));
  },
);

Then(
  "their choices page shows the picture in the footer",
  function (this: TicketsWorld): void {
    const browser = browserSeenBy(this, READER);
    expect(browser.currentHtml).toContain(t("unsubscribe.email_preferences"));
    expectFooterPicture(this, browser.currentHtml);
  },
);
