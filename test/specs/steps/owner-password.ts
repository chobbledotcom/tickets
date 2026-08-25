/**
 * The owner changing their own password: what the site accepts, what it
 * refuses, and what a change does to every signed-in window.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  adminBrowser,
  ORGANISER,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import {
  A_GOOD_NEW_PASSWORD,
  ownerCanSignInWith,
  ownerChangesPassword,
  ownerSignInASecondWindow,
  secondWindowStillSignedIn,
} from "#test/specs/support/owner-password.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { TEST_ADMIN_PASSWORD } from "#test-utils/internal.ts";

// jscpd:ignore-end

Given(
  "the owner is signed in, in their own window",
  async function (this: TicketsWorld): Promise<void> {
    await adminBrowser(this);
  },
);

Given(
  "the owner is signed in, in a second window",
  async function (this: TicketsWorld): Promise<void> {
    await ownerSignInASecondWindow(this);
  },
);

When(
  "the owner tries to change their password, typing the current one wrongly",
  async function (this: TicketsWorld): Promise<void> {
    await ownerChangesPassword(this, {
      currentPassword: "not-the-right-password",
      newPassword: A_GOOD_NEW_PASSWORD,
    });
  },
);

When(
  "the owner tries to change their password, confirming it differently",
  async function (this: TicketsWorld): Promise<void> {
    await ownerChangesPassword(this, {
      confirmPassword: "a-different-long-password",
      newPassword: A_GOOD_NEW_PASSWORD,
    });
  },
);

When(
  "the owner changes their password to {word}",
  async function (this: TicketsWorld, newPassword: string): Promise<void> {
    await ownerChangesPassword(this, { newPassword });
  },
);

Then(
  "the owner is told the current password is incorrect",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("error.current_password_incorrect"),
    );
  },
);

Then(
  "the owner is told the new passwords do not match",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("error.new_passwords_mismatch"),
    );
  },
);

Then(
  "the owner is told the password changed and to log in again",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("success.password_changed"),
    );
  },
);

Then(
  "the old password still signs them in",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ownerCanSignInWith(TEST_ADMIN_PASSWORD)).toBe(true);
  },
);

Then(
  "their old window is signed out",
  async function (this: TicketsWorld): Promise<void> {
    // The owner-only settings page is the test: a window that can still open
    // it never lost its power. The browser is taken as it was left, so it does
    // not sign itself in again on the way.
    const browser = scenarioBrowser(this);
    const answered = await browser.visit("/admin/settings");
    expect(answered).toBe(200);
    expect(browser.pageText).toContain("Login");
  },
);

Then(
  "their second window is signed out too",
  async function (this: TicketsWorld): Promise<void> {
    // This window sent nothing, so its cookie was never cleared by a
    // response: being signed out proves the change ended the sessions the
    // server holds, not just the sending window's own.
    expect(await secondWindowStillSignedIn(this)).toBe(false);
  },
);

Then(
  "they can sign in with the new password",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ownerCanSignInWith(A_GOOD_NEW_PASSWORD)).toBe(true);
  },
);

Then(
  "they cannot sign in with the old one",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ownerCanSignInWith(TEST_ADMIN_PASSWORD)).toBe(false);
  },
);
