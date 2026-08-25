/**
 * The owner changing the password they sign in with. Everything goes through
 * the real settings form, and the password is only believed changed when the
 * sign-in page accepts the new one — the same way its reader would find out.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  adminBrowser,
  organiserSendsAndIsTold,
} from "#test/specs/support/browser.ts";
import { signsInAndCanOpen } from "#test/specs/support/staff-accounts.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

// jscpd:ignore-end

/** The settings page, where the password form lives. */
const SETTINGS_PAGE = "/admin/settings";

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

/** Whether the owner can sign in with this password, proved by opening the
 * settings page only the signed-in owner may see. */
export const ownerCanSignInWith = (password: string): Promise<boolean> =>
  signsInAndCanOpen(TEST_ADMIN_USERNAME, password, SETTINGS_PAGE);
