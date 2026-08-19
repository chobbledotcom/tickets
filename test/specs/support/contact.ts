/**
 * The form a visitor uses to write to the owner. The visitor's half is opened
 * by somebody never signed in, because that is who writes in — and the message
 * itself leaves the site as a real email, so the story watches what was sent.
 */

// jscpd:ignore-start
import { settings } from "#db/settings.ts";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { watchesOutgoing } from "#test/specs/support/outgoing.ts";
import {
  keepWhatTheyWereTold,
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { withEnv } from "#test-utils/env.ts";
import { activateContactForm } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** The person writing in. Everything the site says back is said to them. */
const VISITOR = "the visitor";

/** Where a visitor writes from. */
const CONTACT_PAGE = "/contact";

/** The words on the button a visitor presses to send. */
const SEND = "Send message";

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
  answers: { providerStatus: number },
) =>
  watchesOutgoing((url) => {
    // The checker would say yes. A message turned down while this is standing
    // by was turned down without the checker being asked at all.
    if (url.includes("api.botpoison.com")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes("api.resend.com")) {
      return new Response(null, { status: answers.providerStatus });
    }
    return null;
  })(world);

/** Spam protection is on exactly when both keys are set, and they are read on
 * every request. Each story says plainly whether it wants protection and the
 * keys are put back afterwards — otherwise a machine whose shell already
 * exports them would switch protection on for every story here, and every
 * message would be turned down for a reason the story never mentions. */
const SPAM_KEYS = {
  BOTPOISON_PUBLIC_KEY: "pk_test_public",
  BOTPOISON_SECRET_KEY: "sk_test_secret",
};

const setSpamProtection = (world: TicketsWorld, wanted: boolean): void => {
  world.cleanup.add(
    withEnv(
      Object.fromEntries(
        Object.entries(SPAM_KEYS).map(([name, key]) => [
          name,
          wanted ? key : undefined,
        ]),
      ),
    ),
  );
};

/** The site set up to take messages, with the outside world answering the way
 * one story needs it to. Each way the outside world can behave is the same
 * set-up with different answers, so they are all made from here. */
type SetsUpMessages = (world: TicketsWorld) => Promise<void>;

const takesMessagesWith =
  (answers: {
    providerStatus: number;
    spamProtection: boolean;
  }): SetsUpMessages =>
  async (world) => {
    setSpamProtection(world, answers.spamProtection);
    await activateContactForm();
    watchOutgoing(world, answers);
  };

export const messagesAreWorking: SetsUpMessages = takesMessagesWith({
  providerStatus: 200,
  spamProtection: false,
});

/** The same, but the email provider is having a bad day. */
export const sendingIsBroken: SetsUpMessages = takesMessagesWith({
  providerStatus: 500,
  spamProtection: false,
});

/** The same, with spam protection switched on. A story sending through the
 * page never solves the puzzle, because the puzzle is solved by a script in a
 * real browser — so this is the visitor whose browser ran no script. */
export const spamProtectionIsOn: SetsUpMessages = takesMessagesWith({
  providerStatus: 200,
  spamProtection: true,
});

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
  keepWhatTheyWereTold(world, VISITOR, browser.pageText);
  return browser.pageText;
};

/** What the visitor was told the last time they wrote. */
export const whatVisitorWasTold = (world: TicketsWorld): string =>
  whatTheyWereTold(world, VISITOR);

/** Whether the site asked the spam checker anything at all. */
export const spamCheckWasAsked = (world: TicketsWorld): boolean =>
  requiredWorldValue(world.messagesOut, "the outgoing watch").calls.some(
    ({ url }) => url.includes("api.botpoison.com"),
  );

/** Whether the site sent an email at all. Kept apart from reading the message
 * itself, so "nothing reached the owner" cannot be satisfied by a send whose
 * contents the story merely failed to read. */
export const anEmailWasSent = (world: TicketsWorld): boolean =>
  requiredWorldValue(world.messagesOut, "the outgoing watch").emailCall() !==
  undefined;

/** The message the site sent. A send with nothing readable in it is a broken
 * watch rather than an answer, so it fails loudly instead of reading as
 * "nothing was sent". */
export const messageSent = (world: TicketsWorld): SentMessage => {
  const watching = requiredWorldValue(world.messagesOut, "the outgoing watch");
  const sent = watching.emailCall();
  if (!sent) throw new Error("The site sent no email to read");
  if (!sent.body)
    throw new Error("The site sent an email with no message in it");
  return sent.body as SentMessage;
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
