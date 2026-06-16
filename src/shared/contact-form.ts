/**
 * Public contact form: availability rules and message delivery.
 *
 * The form itself only needs two things:
 *  - the owner enables it on the admin contact page
 *  - the site has a business email address to deliver messages to
 *
 * Spam protection is a progressive enhancement layered on top: when Botpoison
 * is configured (both env keys) the form gains a proof-of-work widget and
 * submissions are verified server-side. Without it the form still works, ready
 * for a different spam-protection provider to be added in future.
 *
 * Delivery shares the building blocks in #shared/inbound-message.ts; the
 * contact-specific policy (deliver to the business email, reply to the
 * submitter, with anti-spoof handling) lives here.
 */

import { getBotpoisonPublicKey, getEffectiveDomain } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import {
  deliverMessage,
  resolveMessageEmailConfig,
} from "#shared/inbound-message.ts";
import {
  emailHost,
  parseEmail,
  type ValidEmail,
} from "#shared/validation/email.ts";

/**
 * Whether the public contact form should be rendered and accept submissions:
 * the owner enabled it and a business email is set. Botpoison is not required.
 */
export const isContactFormActive = (): boolean =>
  settings.contactFormEnabled && settings.businessEmail !== "";

/** Public Botpoison key to embed in the form for the browser widget. Empty when
 * Botpoison is not configured, in which case no widget is shown. */
export const contactFormPublicKey = (): string => getBotpoisonPublicKey();

/** Warning prepended when the submitter claimed an address on the owner's own
 * business email host. */
const SPOOF_BUSINESS_WARNING =
  "It looks like this sender entered an email address on your own business email host. They may be attempting to spoof you.";

/** Warning prepended when the submitter claimed an address on the site's
 * sending (from) email host. */
const SPOOF_FROM_WARNING =
  "It looks like this sender entered an email address on this site's sending email host. They may be attempting to spoof the host.";

/**
 * Choose the Reply-To for a contact submission. Normally it's the submitter so
 * the owner can reply directly. But when the submitter claims an address on a
 * host we trust (the owner's business host, or the site's own sending host) a
 * Reply-To of that address makes the message look self-sent and receiving
 * mailboxes munge the visible sender — so fall back to the from address and
 * flag it with a warning.
 */
const chooseReplyTo = (
  submitter: ValidEmail,
  business: ValidEmail,
  from: ValidEmail,
): { replyTo: ValidEmail; warning: string | null } => {
  const host = emailHost(submitter);
  if (host === emailHost(business)) {
    return { replyTo: from, warning: SPOOF_BUSINESS_WARNING };
  }
  if (host === emailHost(from)) {
    return { replyTo: from, warning: SPOOF_FROM_WARNING };
  }
  return { replyTo: submitter, warning: null };
};

/**
 * Send a contact-form message to the site's business email. The submitter is
 * already validated (a ValidEmail); they are set as Reply-To unless anti-spoof
 * handling redirects it. Returns true when the provider accepted the message.
 */
export const sendContactMessage = async (
  submitter: ValidEmail,
  message: string,
): Promise<boolean> => {
  const config = await resolveMessageEmailConfig();
  if (!config) return false;
  const business = parseEmail(settings.businessEmail);
  if (!business) return false;
  const { replyTo, warning } = chooseReplyTo(
    submitter,
    business,
    config.fromAddress,
  );
  return deliverMessage(config, {
    body: { fromLabel: submitter, message, warning },
    intro: `You have received a message via the ${getEffectiveDomain()} contact form.`,
    replyTo,
    subject: `Contact form message from ${submitter}`,
    to: business,
  });
};
