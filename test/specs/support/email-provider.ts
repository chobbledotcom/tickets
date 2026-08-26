/**
 * The owner connecting the site to an email provider, and testing it.
 *
 * Every send in these stories goes through a stubbed provider, so a scenario
 * says what the provider answers and the site's own handling of that answer is
 * what is under test.
 */

// jscpd:ignore-start

import { settings } from "#db/settings.ts";
import {
  openAdminPage,
  organiserReads,
  organiserSendsTheFormAt,
} from "#test/specs/support/browser.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

const ADVANCED_PATH = "/admin/settings-advanced";

/** Where the connection form and the test button really post. The advanced
 * page carries a dozen forms whose buttons all say Save, so each is reached by
 * where it posts rather than by what its button says. */
const CONNECT_PATH = "/admin/settings/email";
const TEST_PATH = "/admin/settings/email/test";

/** The three boxes the connection form offers. They never reach a story — the
 * owner reads "Email Provider", "API Key" and "From Address". */
const PROVIDER_FIELD = "email_provider";
const KEY_FIELD = "email_api_key";
const FROM_FIELD = "email_from_address";

/** What the site says on the settings pages. */
export const settingsCopy = copyFrom("settings");

/** The owner's own address, which a test email goes to. */
const BUSINESS_EMAIL = "owner@example.com";

/** The key a story's owner gave before the scenario started. Its own constant
 * so the step that reads it back cannot drift from the one that stored it. */
export const KEY_ALREADY_GIVEN = "re_key_from_earlier";

/** The owner opens their advanced settings and keeps what the page said. */
export const ownerOpensAdvancedSettings = organiserReads(ADVANCED_PATH);

/** What the site is set to send with right now, read out of the store rather
 * than off the page, because a saved key is never rendered back. */
export const howTheSiteSends = async (): Promise<{
  apiKey: string;
  from: string;
  provider: string;
}> => {
  const { ALL_SETTINGS_KEYS } = await import("#db/settings.ts");
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  return {
    apiKey: settings.email.apiKey,
    from: settings.email.fromAddress,
    provider: settings.email.provider,
  };
};

/** A provider already connected, as the setup for a story about something
 * else. Written through the settings store rather than the form, so the one
 * send under test is the one the story names. */
export const siteAlreadySendsThrough = async (
  provider: string,
  from: string,
): Promise<void> => {
  await settings.update.email.provider(provider);
  await settings.update.email.apiKey(KEY_ALREADY_GIVEN);
  await settings.update.email.fromAddress(from);
  settings.invalidateCache();
};

/** The owner's own address on file, which is where a test email goes. */
export const ownerHasABusinessEmail = async (): Promise<void> => {
  const { updateBusinessEmail } = await import("#shared/validation/email.ts");
  await updateBusinessEmail(BUSINESS_EMAIL);
  settings.invalidateCache();
};

/** The owner fills the connection form in and saves it, through the form the
 * page really serves, so a page that stopped offering the form fails here.
 * The story says which provider, which key and which address; naming the
 * boxes those go in is this file's job. */
export const ownerConnects = (
  world: TicketsWorld,
  typed: { from?: string; key?: string; provider: string },
): Promise<void> =>
  organiserSendsTheFormAt(world, ADVANCED_PATH, CONNECT_PATH, {
    [PROVIDER_FIELD]: typed.provider,
    ...(typed.from === undefined ? {} : { [FROM_FIELD]: typed.from }),
    ...(typed.key === undefined ? {} : { [KEY_FIELD]: typed.key }),
  });

/** What the provider answers this scenario, or nothing when it never does.
 * Recorded rather than stubbed here, because the send is the only moment an
 * answer is needed. */
export const providerWillAnswer = (
  world: TicketsWorld,
  reply: Response | Error,
): void => {
  world.providerReply = reply;
};

/** The owner presses Send Test Email, with the stub standing in for the
 * account they really have. */
export const ownerSendsATestEmail = async (
  world: TicketsWorld,
): Promise<void> => {
  using _provider = stubFetch(world.providerReply ?? new Response());
  await organiserSendsTheFormAt(world, ADVANCED_PATH, TEST_PATH);
};

/** Which provider the page puts back in the box, read as the browser would
 * submit it. Every provider is rendered as a choice whether or not it is the
 * one on file, so only the chosen option says what the site is set to. */
export const providerTheBoxShows = async (
  world: TicketsWorld,
): Promise<string | null> =>
  (await openAdminPage(world, ADVANCED_PATH)).wouldSendAt(
    CONNECT_PATH,
    PROVIDER_FIELD,
  );

/** Whether the owner really has a way to send a test: a button that is not
 * switched off, on a form that posts to the test address. A heading that says
 * "Send Test Email" beside no such button offers nobody anything. */
export const offersATestSend = async (world: TicketsWorld): Promise<boolean> =>
  (await openAdminPage(world, ADVANCED_PATH)).offersAWayToPost(TEST_PATH);
