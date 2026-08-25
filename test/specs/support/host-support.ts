/**
 * The owner's own way of asking the host for help. The page exists only when
 * the host has an address of their own, and the message leaves the site as a
 * real email — so the story watches what was sent, the same way the
 * visitor-contact one does.
 */

// jscpd:ignore-start
import { settings } from "#db/settings.ts";
import {
  openAsNewcomer,
  organiserSendsAndIsTold,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import {
  answersTheEmailProviderWith,
  type PutsAWatchInPlace,
} from "#test/specs/support/outgoing.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { withEnv } from "#test-utils/env.ts";
import { connectResendProvider } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** The Support page, in the owner's own admin area. */
export const SUPPORT_PAGE = "/admin/support";

/** The address the host reads support messages at. */
export const HOST_ADDRESS = "host@support.test";

/** The words on the button the owner presses to send. */
const SEND = "Send message";

/** The host there to be written to, with the email provider answering the
 * way one story needs it to. The address is put back when the scenario ends,
 * so one story's host cannot still be listening in the next. */
const hostWithinReach = (
  world: TicketsWorld,
  putAWatchInPlace: PutsAWatchInPlace,
): void => {
  world.cleanup.add(withEnv({ ADMIN_EMAIL_ADDRESS: HOST_ADDRESS }));
  putAWatchInPlace(world);
};

/** The host listens, and messages sent to them arrive. */
export const hostListens = (world: TicketsWorld): void =>
  hostWithinReach(world, answersTheEmailProviderWith(200));

/** The host listens, but the email provider is having a bad day. */
export const hostCannotTakeMessages = (world: TicketsWorld): void =>
  hostWithinReach(world, answersTheEmailProviderWith(500));

/** The host has no address configured, so none of this exists. */
export const hostDoesNotListen = (world: TicketsWorld): void => {
  world.cleanup.add(withEnv({ ADMIN_EMAIL_ADDRESS: undefined }));
};

/** The words the host wrote on the Support page, written as markdown with
 * literal \n for line breaks (env values cannot hold real newlines). */
export const hostWritesOnTheSupportPage = (
  world: TicketsWorld,
  markdown: string,
): void => {
  world.cleanup.add(withEnv({ SUPPORT_PAGE_TEXT: markdown }));
};

/** The site able to send its own messages: an address to send from and a
 * provider to send through. */
export const siteCanSendFrom = async (address: string): Promise<void> => {
  await settings.update.businessEmail(address);
  await connectResendProvider();
};

/** The owner writes to the host through the form on the page, and is told
 * something back. */
export const ownerWritesToTheHost = async (
  world: TicketsWorld,
  message: string,
): Promise<void> => {
  await withAdminPage(world, SUPPORT_PAGE, (browser) =>
    organiserSendsAndIsTold(world, browser, { message }, SEND),
  );
};

/** A stranger looks for the Support page and lands wherever the site puts
 * them. */
export const strangerOpensSupportPage = (): Promise<TestBrowser> =>
  openAsNewcomer(SUPPORT_PAGE);
