/**
 * The owner changing the password they sign in with. Everything goes through
 * the real settings form, and the password is only believed changed when the
 * sign-in page accepts the new one — the same way its reader would find out.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  adminBrowser,
  browserSeenBy,
  organiserSendsAndIsTold,
} from "#test/specs/support/browser.ts";
import {
  signInAndRemember,
  signsInAndCanOpen,
} from "#test/specs/support/staff-accounts.ts";
import type { ActOnTheStory, TicketsWorld } from "#test/specs/support/world.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

// jscpd:ignore-end

/** The settings page, where the password form lives. */
const SETTINGS_PAGE = "/admin/settings";

/** The window the owner's second, independent sign-in is kept under. */
const OWNERS_SECOND_WINDOW = "the owner's second window";

/** The owner's own way in, as the seeded admin. */
const OWNER_CREDENTIALS = {
  password: TEST_ADMIN_PASSWORD,
  username: TEST_ADMIN_USERNAME,
};

/** What the owner types when the story is not about the password itself. */
export const A_GOOD_NEW_PASSWORD = "a-new-long-password";

/** The owner sends the password form with these three boxes, and is told
 * something back. The current password defaults to the one they signed in
 * with, so a story about the new one does not repeat the old one. */
export const ownerChangesPassword = async (
  world: TicketsWorld,
  chosen: {
    confirmPassword?: string;
    currentPassword?: string;
    newPassword: string;
  },
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit(SETTINGS_PAGE);
  await organiserSendsAndIsTold(
    world,
    browser,
    {
      current_password: chosen.currentPassword ?? TEST_ADMIN_PASSWORD,
      new_password: chosen.newPassword,
      new_password_confirm: chosen.confirmPassword ?? chosen.newPassword,
    },
    t("settings.change_password"),
  );
};

/** The owner signs in a second time, in a window of their own that sends
 * nothing and changes nothing. Only a change that ends the server-side
 * sessions — not merely the sending window's own cookie — can sign this
 * window out. */
export const ownerSignInASecondWindow: ActOnTheStory = async (world) => {
  await signInAndRemember(OWNER_CREDENTIALS)(world, OWNERS_SECOND_WINDOW);
};

/** Whether the owner's second window — the one that sent nothing — can
 * still open a page only the signed-in owner may see. */
export const secondWindowStillSignedIn = async (
  world: TicketsWorld,
): Promise<boolean> => {
  const browser = browserSeenBy(world, OWNERS_SECOND_WINDOW);
  await browser.visit(SETTINGS_PAGE);
  return !browser.pageText.includes("Login");
};

/** Whether the owner can sign in with this password, proved by opening the
 * settings page only the signed-in owner may see. */
export const ownerCanSignInWith = (password: string): Promise<boolean> =>
  signsInAndCanOpen(TEST_ADMIN_USERNAME, password, SETTINGS_PAGE);
