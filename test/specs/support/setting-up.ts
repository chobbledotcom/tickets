/** The one-off ceremony that turns a bare site into somebody's. */

// jscpd:ignore-start
import { t } from "#i18n";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { checkboxValueOffered } from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const SETUP_PAGE = "/setup/";

/** A page nobody but the owner may open. */
const OWNER_ONLY_PAGE = "/admin/settings";

/** What the first owner types in. */
const CHOSEN = {
  name: "firstowner",
  password: "a-good-long-password",
};

/** What somebody arriving second would type. A different username, so a site
 * that let them through would be theirs and not the first owner's. */
const LATECOMER = {
  name: "secondcomer",
  password: "another-good-password",
};

export const aSiteNobodyHasSetUp = async (): Promise<void> => {
  resetDb();
  await createTestDb(true);
};

/** The setup page, open in front of somebody who has never been here. */
export const openSetup = (): Promise<TestBrowser> => openAsNewcomer(SETUP_PAGE);

/** Somebody fills the setup page in front of them and sends it. Sent through
 * the page's own form, so a value the page would refuse — a password shorter
 * than it asks for, a country it does not list — cannot be sent here either. */
const sendSetup = (
  browser: TestBrowser,
  who: { name: string; password: string },
  confirmation: string,
): Promise<void> =>
  fillInAndSend(
    browser,
    {
      admin_password: who.password,
      admin_password_confirm: confirmation,
      admin_username: who.name,
      country: "GB",
    },
    t("setup.submit"),
    // The agreement is a box somebody ticks, not a value they type, and the
    // page will not send without it.
    {
      accept_agreement: [
        checkboxValueOffered(browser.currentHtml, "accept_agreement"),
      ],
    },
  );

/** Whoever is doing the setting up — the story only ever has one of them, and
 * what they are told is read back a step later. */
const SETTER = "the setter";

/** Somebody opens the setup page and sets the site up. */
export const somebodySetsUp = async (
  world: TicketsWorld,
  password: string,
  confirmation: string,
): Promise<string> => {
  const browser = await openSetup();
  await sendSetup(browser, { ...CHOSEN, password }, confirmation);
  keepWhatTheyWereTold(world, SETTER, browser.pageText);
  return browser.pageText;
};

/** Somebody who had the setup page open before the site was set up sends it
 * afterwards. Their page is never re-opened, because re-opening it is what the
 * site redirects — a stale form is the only way this post can really arrive. */
export const latecomerSendsSetup = async (
  browser: TestBrowser,
): Promise<void> => {
  await sendSetup(browser, LATECOMER, LATECOMER.password);
};

/** The password the story uses when it is not testing the password. */
export const GOOD_PASSWORD = CHOSEN.password;

export const whatSetterWasTold = (world: TicketsWorld): string =>
  whatTheyWereTold(world, SETTER);

/** Whether somebody can sign in with a username and password. The proof that
 * the ceremony finished is a real sign-in, not a page that says it did. */
const canSignIn = async (
  username: string,
  password: string,
): Promise<boolean> => {
  const browser = await openAsNewcomer("/admin/login");
  // A site with no owner has no way in at all — not a wrong password, no door.
  if (!browser.currentHtml.includes('name="username"')) return false;
  await fillInAndSend(browser, { password, username }, t("login.submit"));
  // Only a page nobody but the owner may open proves they were let in. Merely
  // not being asked for a password is true of every signed-out page too. A
  // visitor who is not the owner is sent away from it, so staying there is the
  // answer — and it still has to be a page, not a redirect they followed.
  const answered = await browser.visit(OWNER_ONLY_PAGE);
  return answered === 200 && browser.currentUrl === OWNER_ONLY_PAGE;
};

export const firstOwnerCanSignIn = (password: string): Promise<boolean> =>
  canSignIn(CHOSEN.name, password);

export const latecomerCanSignIn = (): Promise<boolean> =>
  canSignIn(LATECOMER.name, LATECOMER.password);

/** Where somebody opening the setup page ends up, and whether the ceremony is
 * still on offer there. Both matter: a page that stopped redirecting but no
 * longer shows the button would look the same as being sent away. */
export const openingSetupAgain = async (): Promise<{
  landedOn: string;
  stillOffered: boolean;
}> => {
  const browser = await openAsNewcomer(SETUP_PAGE);
  const { pathname } = new URL(browser.currentUrl, "http://localhost");
  return {
    // Both spellings of the address are the live setup page, so a redirect
    // that only dropped the trailing slash has not sent anybody anywhere.
    landedOn: pathname.replace(/\/$/, ""),
    stillOffered: browser.currentHtml.includes(t("setup.submit")),
  };
};
