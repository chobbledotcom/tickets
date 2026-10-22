/**
 * The steps for the unsent-notification notices: what a booking whose send
 * never got accepted shows on the attendee list, on its own page, on the
 * dashboard, and on the merge screen.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  attendeeRowOnList,
  confirmNameLine,
  countLinkOnDashboard,
  linkLabelled,
  listingStopsCollectingAnEmail,
  mergeSections,
  pageSeen,
  pairOwesDifferentSends,
  personWithTicketOwing,
} from "#test/specs/support/notifications.ts";
import { organiserDeletesListing } from "#test/specs/support/privacy.ts";
import {
  attendeeListHtml,
  personWithTicketsForTwoListings,
} from "#test/specs/support/roster.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { setPendingNotificationFlags } from "#test-utils/db-helpers/attendees.ts";
import { adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end

/** The email badge's own words, as the site prints them. */
const emailNotice = () => t("attendees.badge.email_not_sent");

/** The webhooks badge's own words, as the site prints them. */
const webhooksNotice = () => t("attendees.badge.webhooks_not_sent");

/** One person's row on the attendee list the story last opened. */
const rowOnTheList = (world: TicketsWorld, who: string): string =>
  attendeeRowOnList(pageSeen(world), who).row;

/** A ticket whose sends the story names, so every phrasing shares one
 * set-up. The numbers are the flags: 1 says a send never got accepted, 0
 * says it went out or nothing was owed. */
const ticketOwing = (email: number, webhooks: number) =>
  function (this: TicketsWorld, who: string, listing: string) {
    return personWithTicketOwing(this, who, listing, email, webhooks);
  };

/** What one person's list row says about one notice. */
const listSays = (notice: () => string) =>
  function (this: TicketsWorld, who: string): void {
    expect(rowOnTheList(this, who)).toContain(notice());
  };

/** What one person's own page says about one notice. The page the story
 * opened is already that person's, so the step only reads it. */
const ownPageSays = (notice: () => string) =>
  function (this: TicketsWorld, _who: string): void {
    expect(pageSeen(this)).toContain(notice());
  };

/** The admin page the story opens, read whole and carried for the steps that
 * read it. */
const readsAdminPageAt = (path: string) =>
  async function (this: TicketsWorld): Promise<void> {
    const page = await adminGet(path);
    expect(page.status).toBe(200);
    this.notificationsPage = await page.text();
  };

Given(
  "{word} has a ticket for the {word} whose email never went out",
  ticketOwing(1, 0),
);

Given(
  "{word} has a ticket for the {word} whose webhooks never went out",
  ticketOwing(0, 1),
);

Given(
  "{word} has a ticket for the {word} whose email and webhooks never went out",
  ticketOwing(1, 1),
);

Given(
  "{word} has a ticket for the {word} whose sends all went out",
  ticketOwing(0, 0),
);

/** The listing's own attendee list, read whole and carried for the steps
 * that read it. A booking's notice is decided on the booking's listing, so
 * the story opens each listing's list in turn. */
const readsRosterPage = async function (
  this: TicketsWorld,
  listing: string,
): Promise<void> {
  this.notificationsPage = await attendeeListHtml(this, listing);
};

When("the organiser opens the {word}'s attendee list", readsRosterPage);

Given(
  "{word} has tickets for the {word} and the {word} whose email never went out",
  async function (
    this: TicketsWorld,
    who: string,
    first: string,
    second: string,
  ): Promise<void> {
    // The flags sit on the person, so both bookings start owing the email,
    // and only each row's own listing can drop its notice.
    const attendee = await personWithTicketsForTwoListings(
      this,
      who,
      first,
      second,
    );
    await setPendingNotificationFlags(attendee.id, 1, 0);
  },
);

Given(
  "the booking they keep owes an email, and the duplicate owes a webhook",
  function (this: TicketsWorld): Promise<void> {
    return pairOwesDifferentSends(this);
  },
);

When(
  "the organiser opens the attendee list",
  readsAdminPageAt("/admin/attendees"),
);

When("the organiser opens the dashboard", readsAdminPageAt("/admin"));

When(
  "the organiser opens {word}'s own page from the attendee list",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const list = await adminGet("/admin/attendees");
    expect(list.status).toBe(200);
    const { wayIn } = attendeeRowOnList(await list.text(), who);
    const page = await adminGet(wayIn);
    expect(page.status).toBe(200);
    this.notificationsPage = await page.text();
  },
);

When(
  "the organiser opens the re-send notification page from the Actions tab",
  async function (this: TicketsWorld): Promise<void> {
    // The own page's tab strip carries the Actions tab, and the Actions tab
    // carries the re-send action. Following both is the path the organiser
    // clicks.
    const actionsTab = await adminGet(
      linkLabelled(pageSeen(this), t("entity.tab.actions")),
    );
    expect(actionsTab.status).toBe(200);
    const page = await adminGet(
      linkLabelled(await actionsTab.text(), t("attendee_form.action_resend")),
    );
    expect(page.status).toBe(200);
    this.notificationsPage = await page.text();
  },
);

When(
  "the organiser follows the count to the attendee list",
  async function (this: TicketsWorld): Promise<void> {
    const dashboard = await adminGet("/admin");
    expect(dashboard.status).toBe(200);
    const page = await adminGet(countLinkOnDashboard(await dashboard.text()));
    expect(page.status).toBe(200);
    this.notificationsPage = await page.text();
  },
);

Given(
  "the {word} has stopped collecting an email",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return listingStopsCollectingAnEmail(this, listing);
  },
);

When(
  "the {word} stops collecting an email",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return listingStopsCollectingAnEmail(this, listing);
  },
);

Given(
  "the {word} is deleted",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return organiserDeletesListing(this, listing);
  },
);

Then("the list says {word}'s email never went out", listSays(emailNotice));

Then(
  "the list shows {word}'s name and the email notice as separate words",
  function (this: TicketsWorld, who: string): void {
    // The pill carries its own leading space. Read the space off the rendered
    // row, where a screen reader or a copy meets it.
    expect(rowOnTheList(this, who)).toContain(`${who}</a> <span`);
  },
);

Then(
  "the list says {word}'s webhooks never went out",
  listSays(webhooksNotice),
);

Then(
  "the list says {word}'s email and webhooks never went out",
  function (this: TicketsWorld, who: string): void {
    const row = rowOnTheList(this, who);
    expect(row).toContain(emailNotice());
    expect(row).toContain(webhooksNotice());
  },
);

Then(
  "the list says nothing about {word}'s sends",
  function (this: TicketsWorld, who: string): void {
    const row = rowOnTheList(this, who);
    expect(row).not.toContain(emailNotice());
    expect(row).not.toContain(webhooksNotice());
  },
);

Then(
  "the list says nothing about {word}'s email",
  function (this: TicketsWorld, who: string): void {
    expect(rowOnTheList(this, who)).not.toContain(emailNotice());
  },
);

Then(
  "{word}'s own page says their email never went out",
  ownPageSays(emailNotice),
);

Then(
  "{word}'s own page says their webhooks never went out",
  ownPageSays(webhooksNotice),
);

Then(
  "{word}'s own page says nothing about their sends",
  function (this: TicketsWorld, _who: string): void {
    expect(pageSeen(this)).not.toContain(emailNotice());
    expect(pageSeen(this)).not.toContain(webhooksNotice());
  },
);

/** What one person's details name line says about one notice. The line is
 * already that person's, so the step only reads the notice off it. */
const resendSays = (notice: () => string) =>
  function (this: TicketsWorld, who: string): void {
    expect(confirmNameLine(pageSeen(this), who)).toContain(notice());
  };

Then(
  "the re-send page says {word}'s email never went out beside their name",
  resendSays(emailNotice),
);

Then(
  "the re-send page says {word}'s webhooks never went out beside their name",
  resendSays(webhooksNotice),
);

Then(
  "the re-send page says nothing about {word}'s sends",
  function (this: TicketsWorld, who: string): void {
    const line = confirmNameLine(pageSeen(this), who);
    expect(line).not.toContain(emailNotice());
    expect(line).not.toContain(webhooksNotice());
  },
);

Then(
  "the dashboard counts {int} attendee(s) with unsent notifications",
  function (this: TicketsWorld, count: number): void {
    expect(pageSeen(this)).toContain(
      t("admin.dashboard.pending_notifications", { count }),
    );
  },
);

Then(
  "the dashboard says nothing about unsent notifications",
  function (this: TicketsWorld): void {
    // The section renders only above zero, so every wording it can ever
    // print — one attendee, several, and the zero it must never print —
    // stays absent.
    for (const count of [0, 1, 2]) {
      expect(pageSeen(this)).not.toContain(
        t("admin.dashboard.pending_notifications", { count }),
      );
    }
  },
);

Then(
  "the kept booking's section says its email never went out",
  function (this: TicketsWorld): void {
    const { kept } = mergeSections(
      requiredWorldValue(this.mergePreviewHtml, "the merge screen"),
    );
    expect(kept).toContain(emailNotice());
    expect(kept).not.toContain(webhooksNotice());
  },
);

Then(
  "the duplicate's section says its webhooks never went out",
  function (this: TicketsWorld): void {
    const { duplicate } = mergeSections(
      requiredWorldValue(this.mergePreviewHtml, "the merge screen"),
    );
    expect(duplicate).toContain(webhooksNotice());
    expect(duplicate).not.toContain(emailNotice());
  },
);

Then(
  "neither booking's section says a send never went out",
  function (this: TicketsWorld): void {
    const { kept, duplicate } = mergeSections(
      requiredWorldValue(this.mergePreviewHtml, "the merge screen"),
    );
    for (const section of [kept, duplicate]) {
      expect(section).not.toContain(emailNotice());
      expect(section).not.toContain(webhooksNotice());
    }
  },
);
