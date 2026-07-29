/**
 * The one-off ceremony that turns a bare site into somebody's. Everything here
 * happens before any owner exists, so the whole story is told by a person who
 * has never signed in and could not.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  fillInAndSend,
} from "#test/specs/support/form-controls.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Where a site is set up, and where it says so afterwards. */
const SETUP_PAGE = "/setup/";

/** What the first owner types in. The country is picked from the page's own
 * list, so the story can never choose one the page does not offer. */
const CHOSEN = {
  name: "firstowner",
  password: "a-good-long-password",
};

/** A site nobody has set up yet: the database is there and the site answers,
 * but the ceremony that makes an owner has never been run. The scenario's own
 * cleanup still puts this back, because it is the same database it was given. */
export const aSiteNobodyHasSetUp = async (): Promise<void> => {
  resetDb();
  await createTestDb(true);
};

/** The setup page, open in front of somebody who has never been here. */
const openSetup = (): Promise<TestBrowser> => openAsNewcomer(SETUP_PAGE);

/** Somebody sets the site up, typing the password once into each box. Sent
 * through the page's own form, so a value the page would not accept — a
 * password shorter than it asks for, a country it does not list — cannot be
 * sent by the story either. */
export const somebodySetsUp = async (
  world: TicketsWorld,
  password: string,
  confirmation: string,
): Promise<string> => {
  const browser = await openSetup();
  await fillInAndSend(
    browser,
    {
      // Whatever the page's own tickbox sends, rather than a word the story
      // believes in — a tickbox sending something the site does not expect
      // would stop anybody finishing, and this has to fail with them.
      accept_agreement: checkboxValueOffered(
        browser.currentHtml,
        "accept_agreement",
      ),
      admin_password: password,
      admin_password_confirm: confirmation,
      admin_username: CHOSEN.name,
      country: "GB",
    },
    t("setup.submit"),
  );
  world.setUpTold = browser.pageText;
  return browser.pageText;
};

/** The password the story would use when it is not testing the password. */
export const GOOD_PASSWORD = CHOSEN.password;

/** What whoever was setting the site up was told. */
export const whatSetterWasTold = (world: TicketsWorld): string =>
  requiredWorldValue(world.setUpTold, "what the setter was told");

/** Whether the first owner can now sign in with what they chose. Proving the
 * ceremony finished means using it, not reading a page that says it did. */
export const firstOwnerCanSignIn = async (
  password: string,
): Promise<boolean> => {
  const browser = await openAsNewcomer("/admin/login");
  // A site with no owner has no way in at all, which is the plainest form of
  // "nobody can sign in" — not a wrong password, no door.
  if (!browser.currentHtml.includes('name="username"')) return false;
  await fillInAndSend(
    browser,
    { password, username: CHOSEN.name },
    t("login.submit"),
  );
  // Being signed in means the site stopped asking. A refused password lands
  // back on a page still offering the box, and the address it lands on is the
  // same either way — so the address says nothing.
  return !browser.currentHtml.includes('name="password"');
};

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
