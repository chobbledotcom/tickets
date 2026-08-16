/**
 * Somebody the site emails choosing what may be sent to them: following the
 * link at the bottom of a promotion, asking not to hear, changing their mind,
 * and deleting the record the site keeps under their one-way code.
 *
 * Every press is a real form send off the reader's own served page, so a page
 * that stopped rendering a button fails the story instead of being stepped
 * around.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { queryOne } from "#shared/db/client.ts";
import {
  hashEmail,
  isHashUnsubscribed,
} from "#shared/db/contact-preferences.ts";
import {
  browserSeenBy,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  keepWhatTheyWereTold,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { findForms, pressableOn } from "#test-utils/test-browser/forms.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Whose browser the choices journey keeps: the person reading the email. */
export const READER = "the reader";

/** Where the choices page lives. The one production path this journey knows:
 * the page every choices link leads to, and the address its forms post back
 * to. */
export const CHOICES_PATH = "/unsubscribe";

/** The address of whoever is on their choices page in this story, so a later
 * step can ask about the right person without the feature repeating an
 * address. */
const readerAddresses = new WeakMap<TicketsWorld, string>();

export const addressOfTheReader = (world: TicketsWorld): string =>
  requiredWorldValue(readerAddresses.get(world), "the reader's address");

/** Where one address's choices page lives — found by its one-way code, the
 * only name the link from an email ever carries. */
const choicesPathFor = async (email: string): Promise<string> =>
  `${CHOICES_PATH}?email=${encodeURIComponent(await hashEmail(email))}`;

/** The choices link inside one person's copy of an email — the address the
 * message really carried, not one the story built. A promotion without one is
 * itself wrong, so the miss fails loudly. */
export const choicesLinkIn = (copy: { html: string }): string => {
  const hrefs = [...copy.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  const link = hrefs.find((href) => href.includes(CHOICES_PATH));
  if (!link) throw new Error("Their copy carries no choices link");
  return link;
};

/** One person follows a choices link, and the story keeps their window and
 * their address for the steps that come after. */
export const followsChoicesLink = async (
  world: TicketsWorld,
  email: string,
  link: string,
): Promise<TestBrowser> => {
  readerAddresses.set(world, email);
  return rememberBrowser(world, READER, await openAsNewcomer(link));
};

/** Somebody tells the site they would rather not hear about promotions — the
 * way a real reader does: their own choices page, its real Unsubscribe form.
 * Shared with the stories about writing to the people who booked, so both
 * exercise the one mechanism a reader really has. */
export const asksNotToHearAboutPromotions = async (
  email: string,
): Promise<TestBrowser> => {
  const browser = await openAsNewcomer(await choicesPathFor(email));
  await fillInAndSend(browser, {}, t("unsubscribe.unsubscribe_button"));
  return browser;
};

/** The Given form of the ask: the reader has already been to their page and
 * pressed the button, and the story keeps their window and address. */
export const hasAskedNotToHear = async (
  world: TicketsWorld,
  email: string,
): Promise<void> => {
  readerAddresses.set(world, email);
  rememberBrowser(world, READER, await asksNotToHearAboutPromotions(email));
};

/** The reader presses one button on the page they are looking at, and the
 * story keeps what the site told them. */
const pressesOnTheirPage = async (
  world: TicketsWorld,
  label: string,
): Promise<void> => {
  const browser = browserSeenBy(world, READER);
  await fillInAndSend(browser, {}, label);
  keepWhatTheyWereTold(world, READER, browser.pageText);
};

export const asksToStopHearing = (world: TicketsWorld): Promise<void> =>
  pressesOnTheirPage(world, t("unsubscribe.unsubscribe_button"));

export const changesTheirMind = (world: TicketsWorld): Promise<void> =>
  pressesOnTheirPage(world, t("unsubscribe.resubscribe_button"));

export const deletesTheirData = (world: TicketsWorld): Promise<void> =>
  pressesOnTheirPage(world, t("unsubscribe.forget_button"));

/** Whether the reader's page offers one of its presses — a live button in a
 * form that would send the named choice, not just words on the page. */
export const pageOffersChoice = (
  browser: TestBrowser,
  action: "unsubscribe" | "resubscribe" | "forget",
): boolean =>
  findForms(browser.currentHtml).some(
    (form) =>
      form.body.includes(`value="${action}"`) && pressableOn(form).length > 0,
  );

/** Whether the site counts one address as having asked not to hear — read
 * through the same question the promotion send path asks before writing. */
export const countedAsAskedNotToHear = async (
  email: string,
): Promise<boolean> => isHashUnsubscribed(await hashEmail(email));

/** Whether any record at all is kept under one address's one-way code. Asked
 * of the table itself, because every production read answers the same for "no
 * row" and "a row of zeroes" — and this claim is precisely that the row is
 * gone. */
export const recordKeptUnderTheirCode = async (
  email: string,
): Promise<boolean> =>
  (await queryOne<{ present: number }>(
    "SELECT 1 AS present FROM contact_preferences WHERE contact_hash = ?",
    [await hashEmail(email)],
  )) !== null;
