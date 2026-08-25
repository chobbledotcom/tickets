/**
 * Invited staff setting up their own account through the same pages they use
 * outside a story. The owner creates the invite from Users; the invited person
 * follows that link, chooses a password, then proves it by logging in from a
 * separate browser of their own.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  browserSeenBy,
  openAdminPage,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type {
  ActOnOnePerson,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** Staff roles whose account journeys are shared by the acceptance stories. */
export type InvitedStaffRole = "editor" | "manager";

/** The password an invited staff member chooses for themselves. */
const STAFF_PASSWORD = "a-good-long-password";

/** The name under which a manager's separate browser is kept. */
const managerBrowserName = (who: string): string => `manager ${who}`;

/** The name under which the owner's one-time link is kept until it is used. */
const managerInviteName = (who: string): string =>
  `the manager invite for ${who}`;

/** The owner fills in the rendered invite form and reads back the link the
 * site gives them. The role must be offered by that form. */
export const createStaffInvite = async (
  world: TicketsWorld,
  who: string,
  role: InvitedStaffRole,
): Promise<string> => {
  const browser = await openAdminPage(world, "/admin/user/new");
  await fillInAndSend(
    browser,
    { admin_level: role, username: who },
    t("users.invite.submit"),
  );
  const link = browser.pageText.match(/\/join\/[A-Za-z0-9_-]+/)?.[0];
  if (!link) throw new Error(`The owner was given no link to send ${who}`);
  return link;
};

/** The invited person follows the real link and chooses their password in the
 * form it serves. This browser holds only the single-use invitation visit. */
export const acceptStaffInvite = async (
  invite: string,
): Promise<TestBrowser> => {
  const browser = await openAsNewcomer(invite);
  await fillInAndSend(
    browser,
    { password: STAFF_PASSWORD, password_confirm: STAFF_PASSWORD },
    t("join.set_password.submit"),
  );
  return browser;
};

/** Follow an invite and keep the resulting browser under one story name. */
export const rememberAcceptedStaffInvite = async (
  world: TicketsWorld,
  browserName: string,
  invite: string,
): Promise<TestBrowser> =>
  rememberBrowser(world, browserName, await acceptStaffInvite(invite));

/** Sign in through the ordinary login form from a fresh browser, and hand
 * back the browser they are now looking at. */
const signsInOnAFreshPage = async (
  who: string,
  password: string,
): Promise<TestBrowser> => {
  const browser = await openAsNewcomer("/admin/");
  await fillInAndSend(browser, { password, username: who }, t("login.submit"));
  return browser;
};

/** The activated staff member signs in, then keeps that signed-in browser
 * for their later actions. */
export const logStaffIn = async (
  world: TicketsWorld,
  who: string,
  browserName: string,
): Promise<TestBrowser> =>
  rememberBrowser(
    world,
    browserName,
    await signsInOnAFreshPage(who, STAFF_PASSWORD),
  );

/** The owner invites a manager through the rendered Users form. */
export const ownerInvitesManager: ActOnOnePerson = async (world, who) => {
  world.things.remember(
    "told",
    managerInviteName(who),
    await createStaffInvite(world, who, "manager"),
  );
};

/** The manager follows the owner's link, chooses a password, and then really
 * signs in from their own new browser. */
export const managerAcceptsInviteAndLogsIn: ActOnOnePerson = async (
  world,
  who,
) => {
  await acceptStaffInvite(world.things.require("told", managerInviteName(who)));
  await logStaffIn(world, who, managerBrowserName(who));
};

/** One named manager's signed-in browser. */
export const managerBrowser = (world: TicketsWorld, who: string): TestBrowser =>
  browserSeenBy(world, managerBrowserName(who));

/** A manager opens a page in their own signed-in browser. */
export const openManagerPage = async (
  world: TicketsWorld,
  who: string,
  path: string,
): Promise<TestBrowser> => {
  const browser = managerBrowser(world, who);
  await browser.visit(path);
  return browser;
};

/** Whether somebody can sign in with this password, proved by opening a page
 * only the signed-in staff may see. Merely being refused once proves
 * nothing: the sign-in page shows everybody the same form, so the page they
 * land on afterwards is the answer. */
export const signsInAndCanOpen = async (
  who: string,
  password: string,
  maySeeWhenSignedIn: string,
): Promise<boolean> => {
  const browser = await signsInOnAFreshPage(who, password);
  const answered = await browser.visit(maySeeWhenSignedIn);
  return (
    answered === 200 &&
    browser.currentUrl.replace(/\/$/, "") === maySeeWhenSignedIn
  );
};

/** Whether an invited staff member can still sign in with the password they
 * chose. The site files usernames in lower case, so the name is typed the
 * way the site keeps it. */
export const staffMemberCanSignIn = (who: string): Promise<boolean> =>
  signsInAndCanOpen(who.toLowerCase(), STAFF_PASSWORD, "/admin/attendees");
