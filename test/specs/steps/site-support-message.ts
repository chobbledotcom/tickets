// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { pageShowsPicture } from "#test/specs/support/attendee-images.ts";
import { openAdminPage, scenarioBrowser } from "#test/specs/support/browser.ts";
import { keepSiteForReadingOnly } from "#test/specs/support/features.ts";
import {
  siteCarriesSupportMessageWithPicture,
  supportMessageTab,
} from "#test/specs/support/site-support-message.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "a built site carries a support message with a picture called {string} in it",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await siteCarriesSupportMessageWithPicture(this, name);
  },
);

Given("the site is read-only", function (this: TicketsWorld): void {
  keepSiteForReadingOnly(this);
});

When(
  "the organiser opens the site's Support message tab",
  async function (this: TicketsWorld): Promise<void> {
    const siteId = this.things.require("record", "built site");
    await openAdminPage(this, supportMessageTab(siteId));
  },
);

Then(
  "the message panel shows the {string} picture",
  function (this: TicketsWorld, _name: string): void {
    pageShowsPicture(scenarioBrowser(this).currentHtml, this);
  },
);

Then(
  "the message panel offers no way to edit the message",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).currentHtml).not.toContain(
      'name="support_message"',
    );
  },
);
