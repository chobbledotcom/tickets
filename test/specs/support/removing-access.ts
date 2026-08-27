/**
 * The owner taking somebody's access away. The way in is the one the site
 * offers — the Users list, the person's own page, the delete link behind its
 * Actions tab — and the person's password is the proof it worked, because
 * that is what they would notice.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  keepsWhatTheOrganiserSaw,
  openAdminPage,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import { takeDownFromActions } from "#test/specs/support/form-controls.ts";
import type {
  ReadAboutOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The Users list, where the owner picks the person to remove. */
const USERS_LIST = "/admin/users";

/** The words on the delete link and the button that confirms it, read when
 * the story needs them (the catalog is not loaded at import time). */
const deleteUserLabel = (): string => t("users.delete_user.submit");

/** The address of the row naming one person, matched the way the site itself
 * matches usernames — in lower case — or nothing when no row names them. */
const rowNaming = (browser: TestBrowser, who: string): string | null =>
  browser.links.find(
    ({ text }) => text.trim().toLowerCase() === who.toLowerCase(),
  )?.href ?? null;

/** The owner takes one person down, typing this to confirm, and is told
 * something back. Every way in is followed rather than built, so a person
 * the site stopped offering a way to remove is one the story cannot remove
 * either. */
export const ownerTakesDown = async (
  world: TicketsWorld,
  who: string,
  typed: string,
): Promise<void> => {
  await withAdminPage(world, USERS_LIST, async (browser) => {
    await browser.clickLink(who);
    await takeDownFromActions(browser, typed, {
      deleteLink: deleteUserLabel(),
      submit: deleteUserLabel(),
    });
    keepsWhatTheOrganiserSaw(world, browser);
  });
};

/** The address of one person's row on the Users list, or nothing when no
 * row names them — the list is the surface the owner actually reads. */
export const rowAddressFor: ReadAboutOneThing<string | null> = async (
  world,
  who,
) => rowNaming(await openAdminPage(world, USERS_LIST), who);
