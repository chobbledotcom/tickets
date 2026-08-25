/**
 * The owner asking the host for help: what the page shows, what a message
 * carries, and what the owner is told when one did not go.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { getEffectiveDomain } from "#shared/config.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import {
  adminBrowser,
  ORGANISER,
  openAdminPage,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  HOST_ADDRESS,
  hostCannotTakeMessages,
  hostDoesNotListen,
  hostListens,
  hostWritesOnTheSupportPage,
  ownerWritesToTheHost,
  SUPPORT_PAGE,
  siteCanSendFrom,
  strangerOpensSupportPage,
} from "#test/specs/support/host-support.ts";
import { managerBrowser } from "#test/specs/support/staff-accounts.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import type { RecordedFetchCall } from "#test-utils/mocks.ts";

// jscpd:ignore-end

/** The site's own words, read from production rather than written out here:
 * what it says when a support message went. The wording lives in the route
 * that sends it, src/features/admin/support.ts. */
const SENT = "Your message has been sent";

/** What the site says when the box was sent with nothing in it. The wording
 * lives in requireMessageField, src/shared/inbound-message.ts. */
const ENTER_A_MESSAGE = "Please enter a message.";

/** The reminder the page shows after a message went. The full wording, with
 * its bold time value, lives in the catalog key support.last_submitted; the
 * words before that value are the same on every visit. */
const LAST_SUBMITTED = "You last submitted this form";

/** The words every support message's subject opens with, written out here
 * rather than read from the production builder, so a builder that drops or
 * rewords the site's name fails the story instead of moving with it. The
 * domain is read from the site's own config: it is the address this story's
 * site really runs on, not a wording the code under test chose. */
const expectedSubject = (): string =>
  `Support message from Chobble Tickets site ${getEffectiveDomain()}`;

/** The email the site sent, or a loud failure — reading "no email" as the
 * answer would let a send with nothing readable in it pass for a delivery. */
const sentEmail = (world: TicketsWorld): RecordedFetchCall => {
  const sent = requiredWorldValue(
    world.messagesOut,
    "the outgoing watch",
  ).emailCall();
  if (!sent) throw new Error("The site sent no email to read");
  return sent;
};

/** The stranger in a story of their own, keeping their own window. */
const STRANGER = "the stranger";

Given(
  "the host listens for the owner's messages",
  function (this: TicketsWorld): void {
    hostListens(this);
  },
);

Given(
  "the host listens for the owner's messages, but cannot take them right now",
  function (this: TicketsWorld): void {
    hostCannotTakeMessages(this);
  },
);

Given(
  "the host does not listen for support messages",
  function (this: TicketsWorld): void {
    hostDoesNotListen(this);
  },
);

Given(
  "the host has written {string} on the Support page",
  function (this: TicketsWorld, markdown: string): void {
    hostWritesOnTheSupportPage(this, markdown);
  },
);

Given(
  "the site can send email from {string}",
  function (this: TicketsWorld, address: string): Promise<void> {
    return siteCanSendFrom(address);
  },
);

When(
  "the owner opens the Support page",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, SUPPORT_PAGE);
  },
);

When(
  "the owner writes {string} to the host",
  async function (this: TicketsWorld, message: string): Promise<void> {
    await ownerWritesToTheHost(this, message);
  },
);

When(
  "the owner tries to send a message with nothing in it",
  async function (this: TicketsWorld): Promise<void> {
    await ownerWritesToTheHost(this, "   ");
  },
);

When(
  "Sam opens the Support page in his own window",
  async function (this: TicketsWorld): Promise<void> {
    await managerBrowser(this, "Sam").visit(SUPPORT_PAGE);
  },
);

When(
  "a stranger opens the Support page",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await strangerOpensSupportPage();
    rememberBrowser(this, STRANGER, browser);
  },
);

Then(
  "Sam is not allowed to open it",
  async function (this: TicketsWorld): Promise<void> {
    expect(await managerBrowser(this, "Sam").statusOf(SUPPORT_PAGE)).toBe(403);
  },
);

Then(
  "the stranger is asked to sign in first",
  async function (this: TicketsWorld): Promise<void> {
    // Sent to the admin area, which answers with the sign-in page — not the
    // Support page itself and not an error.
    const browser = this.things.require("browser", STRANGER);
    expect(browser.pageText).toContain("Login");
    expect(browser.currentUrl).not.toContain("support");
  },
);

Then(
  "the owner finds no Support page",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    expect(await browser.statusOf(SUPPORT_PAGE)).toBe(404);
  },
);

Then(
  "the settings area offers no link to one",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await browser.visit("/admin/settings");
    expect(browser.currentHtml).not.toContain(`href="${SUPPORT_PAGE}"`);
  },
);

Then(
  "the owner reads {string} as a heading and {string} as its words",
  async function (
    this: TicketsWorld,
    heading: string,
    words: string,
  ): Promise<void> {
    const html = (await openAdminPage(this, SUPPORT_PAGE)).currentHtml;
    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toContain(`<p>${words}</p>`);
  },
);

Then(
  "the page does not say the host has written nothing",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, SUPPORT_PAGE);
    expect(browser.pageText).not.toContain(t("support.missing_text"));
  },
);

Then(
  "the owner is told the host has written nothing yet",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, SUPPORT_PAGE);
    expect(browser.pageText).toContain(t("support.missing_text"));
  },
);

Then(
  "the owner is offered no form to write in",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, SUPPORT_PAGE);
    expect(browser.currentHtml).not.toContain(`action="${SUPPORT_PAGE}"`);
  },
);

Then(
  "the owner is offered a message box and nothing else to fill in",
  async function (this: TicketsWorld): Promise<void> {
    const html = (await openAdminPage(this, SUPPORT_PAGE)).currentHtml;
    expect(html).toContain(`action="${SUPPORT_PAGE}"`);
    expect(html).toContain('name="message"');
    expect(html).not.toContain('name="email"');
  },
);

Then(
  "the owner is told the message was sent",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(SENT);
  },
);

Then(
  "the owner is told it could not be sent",
  function (this: TicketsWorld): void {
    const told = whatTheyWereTold(this, ORGANISER);
    expect(told).toContain(MESSAGE_SEND_FAILED);
    expect(told).not.toContain(SENT);
  },
);

Then(
  "the owner is told to enter a message",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(ENTER_A_MESSAGE);
  },
);

Then("the message reaches the host", function (this: TicketsWorld): void {
  const sent = sentEmail(this);
  expect(sent.body?.to).toEqual([HOST_ADDRESS]);
  // The words the owner typed are the message: a delivery that dropped them
  // or swapped them for something else is not the message reaching anybody.
  const written = requiredWorldValue(
    this.messageWritten,
    "the message written",
  );
  expect(String(sent.body?.html ?? "")).toContain(written);
});

Then("nothing reaches the host", function (this: TicketsWorld): void {
  const watching = requiredWorldValue(this.messagesOut, "the outgoing watch");
  expect(watching.emailCall()).toBeUndefined();
});

Then(
  "the message names the site it came from",
  function (this: TicketsWorld): void {
    expect(String(sentEmail(this).body?.subject)).toBe(expectedSubject());
  },
);

Then(
  "the owner is reminded they sent a message a moment ago",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, SUPPORT_PAGE);
    expect(browser.pageText).toContain(LAST_SUBMITTED);
  },
);
