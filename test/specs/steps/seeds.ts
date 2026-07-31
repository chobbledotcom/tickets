/** An organiser fills the site with example data and looks around. */

// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { DEMO_LISTING_NAMES, DEMO_NAMES } from "#shared/demo/samples.ts";
import { openAdminPage, scenarioBrowser } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { fieldValueOnPage, openAttendeeEditor } from "#test-utils/e2e.ts";

// jscpd:ignore-end

/** The first free example listing. Every second example listing is free, and
 * the free one lists its attendee with an ordinary Edit link — a paid example
 * attendee has no payment, so it is parked under failed payments instead. */
const freeExampleListing = (): string => DEMO_LISTING_NAMES[1]!;

When(
  "the organiser asks for {int} example listings with {int} attendee(s) each",
  async function (
    this: TicketsWorld,
    listings: number,
    perListing: number,
  ): Promise<void> {
    // The page is opened before its button's name is looked up: the seeds
    // wording only joins the catalog when the seeds page first loads.
    const browser = await openAdminPage(this, "/admin/seeds");
    await fillInAndSend(
      browser,
      {
        attendees_per_listing: String(perListing),
        listing_count: String(listings),
      },
      t("admin.seeds.submit"),
    );
  },
);

Then(
  "they are told {int} listings and {int} attendees were created",
  function (this: TicketsWorld, listings: number, attendees: number): void {
    expect(scenarioBrowser(this).pageText).toContain(
      t("admin.seeds.created", { attendees, listings }),
    );
  },
);

Then(
  "an example listing is on the dashboard",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, "/admin");
    expect(browser.pageText).toContain(freeExampleListing());
  },
);

When(
  "the organiser opens an example attendee's record from that listing",
  async function (this: TicketsWorld): Promise<void> {
    // Every way in is followed, not built: the dashboard's listing link, the
    // listing's list of attendees, then the Edit link beside the attendee.
    const browser = scenarioBrowser(this);
    await browser.clickLink(freeExampleListing());
    await browser.visit(`${browser.currentUrl}/attendees`);
    await openAttendeeEditor(browser);
  },
);

Then(
  "the record offers the attendee's example name to edit",
  function (this: TicketsWorld): void {
    // The name box holding a real example name proves the attendee's locked
    // details were opened and read back, not merely that a box rendered.
    expect(DEMO_NAMES).toContain(
      fieldValueOnPage(scenarioBrowser(this), "name"),
    );
  },
);
