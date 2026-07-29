/**
 * The form a visitor uses to write to the owner. The visitor's half is opened
 * by somebody never signed in, because that is who writes in — and the message
 * itself leaves the site as a real email, so the story watches what was sent.
 */

// jscpd:ignore-start
import { settings } from "#shared/db/settings.ts";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { installRecordingFetch } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** Where a visitor writes from, and where their message is meant to land. */
const CONTACT_PAGE = "/contact";
export const OWNER_INBOX = "owner@example.com";

/** The words on the button a visitor presses to send. */
const SEND = "Send message";

/** Everything the form needs before a visitor can use it: the public site on,
 * an address for messages to reach, the form switched on, and a way to send
 * email at all. A story can take any one of these away afterwards. */
export const ownerOffersMessages = async (): Promise<void> => {
  await enablePublicSite();
  await settings.update.businessEmail(OWNER_INBOX);
  await settings.update.contactFormEnabled(true);
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_test_key");
};

/** The owner takes one part of that away, by the word the story uses for it. */
const TAKEN_AWAY: Record<string, () => Promise<unknown>> = {
  "the form": () => settings.update.contactFormEnabled(false),
  "their address": () => settings.update.businessEmail(""),
};

export const ownerTakesAway = (what: string): Promise<unknown> =>
  requiredWorldValue(TAKEN_AWAY[what], `a way to take away "${what}"`)();

/** What the site does with the outside world while one story runs: answers the
 * spam check and the email provider, and remembers every send. Put back when
 * the scenario ends, so one story's stand-in cannot leak into the next. */
const watchOutgoing = (
  world: TicketsWorld,
  answers: { checkPasses: boolean; providerStatus: number },
) => {
  const watching = installRecordingFetch((url) => {
    if (url.includes("api.botpoison.com")) {
      return new Response(JSON.stringify({ ok: answers.checkPasses }));
    }
    if (url.includes("api.resend.com")) {
      return new Response(null, { status: answers.providerStatus });
    }
    return null;
  });
  world.cleanup.push(watching.restore);
  world.messagesOut = watching;
  return watching;
};

/** The site set up to take messages, with the outside world answering the way
 * one story needs it to. Each way the outside world can behave is the same
 * set-up with different answers, so they are all made from here. */
type SetsUpMessages = (world: TicketsWorld) => Promise<void>;

const takesMessagesWith =
  (answers: { checkPasses: boolean; providerStatus: number }): SetsUpMessages =>
  async (world) => {
    await ownerOffersMessages();
    watchOutgoing(world, answers);
  };

export const messagesAreWorking: SetsUpMessages = takesMessagesWith({
  checkPasses: true,
  providerStatus: 200,
});

/** The same, but the email provider is having a bad day. */
export const sendingIsBroken: SetsUpMessages = takesMessagesWith({
  checkPasses: true,
  providerStatus: 500,
});

/** The same, with spam protection switched on and set to turn this one down.
 * The keys are read on each request, so putting them back at the end of the
 * scenario is enough to leave the next story without spam protection. */
export const spamCheckTurnsMessagesDown: SetsUpMessages = async (world) => {
  for (const [name, value] of Object.entries({
    BOTPOISON_PUBLIC_KEY: "pk_test_public",
    BOTPOISON_SECRET_KEY: "sk_test_secret",
  })) {
    const before = process.env[name];
    world.cleanup.push(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
    process.env[name] = value;
  }
  await takesMessagesWith({ checkPasses: false, providerStatus: 200 })(world);
};

/** Whether the page a visitor lands on really offers them a form to fill in.
 * A page that merely answers is not the same as a page they can write from. */
export const visitorIsOfferedAForm = async (): Promise<boolean> =>
  (await openAsNewcomer(CONTACT_PAGE)).currentHtml.includes(
    "<textarea maxlength=",
  );

/** Whether the site offers the page at all. */
export const contactPageAnswers = async (): Promise<number> =>
  (await openAsNewcomer("/")).statusOf(CONTACT_PAGE);

/** A visitor writes to the owner through the form on the page, and is told
 * something back. Sent the way a person would: the page is opened first, so
 * the form's own hidden fields go along with it. */
export const visitorWrites = async (
  world: TicketsWorld,
  from: string,
  message: string,
): Promise<string> => {
  const browser = await openAsNewcomer(CONTACT_PAGE);
  await fillInAndSend(browser, { email: from, message }, SEND);
  world.visitorTold = browser.pageText;
  return browser.pageText;
};

/** What the visitor was told the last time they wrote. */
export const whatVisitorWasTold = (world: TicketsWorld): string =>
  requiredWorldValue(world.visitorTold, "what the visitor was told");

/** The email the site sent, or nothing when it sent none. */
export const messageSent = (world: TicketsWorld): SentMessage | null => {
  const watching = requiredWorldValue(world.messagesOut, "the outgoing watch");
  return (watching.emailCall()?.body ?? null) as SentMessage | null;
};

/** The parts of a sent message a story reads: who it went to, where a reply
 * would go, and the words the owner reads. */
type SentMessage = { html?: string; reply_to?: string; to?: string[] };

/** An address on the owner's very own host. A sender claiming one of these is
 * the case the site treats as a possible spoof. */
export const ADDRESS_ON_OWNERS_HOST = "not-really-the-owner@example.com";

/** The warning the owner reads on a message whose sender claimed an address on
 * a host the site trusts. Read from production so a reworded warning fails
 * here rather than quietly leaving the owner unwarned. */
export const SPOOF_WARNING = "attempting to spoof";

/** The site's own words, read from production rather than written out in the
 * stories: what it says when a message went, and when the spam check turned it
 * down. What it says about an undelivered message is MESSAGE_SEND_FAILED,
 * which the steps read straight from production. */
export const SENT = "Message sent";
export const COULD_NOT_CHECK = "Could not verify your submission.";
