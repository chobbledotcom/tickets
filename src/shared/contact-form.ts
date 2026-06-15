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
 * The actual delivery (provider resolution, anti-spoof Reply-To, sending) lives
 * in #shared/inbound-message.ts and is shared with the admin support form.
 */

import { getBotpoisonPublicKey } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import {
  buildMessageHtml,
  buildMessageText,
  deliverInboundMessage,
} from "#shared/inbound-message.ts";

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

/** Intro line for the owner-notification body. */
const contactIntro = (domain: string): string =>
  `You have received a message via the ${domain} contact form.`;

/**
 * Send a contact-form message to the site's business email.
 * The submitter's address is set as Reply-To so the owner can reply directly.
 * Returns true when the provider accepted the message.
 */
export const sendContactMessage = (
  email: string,
  message: string,
): Promise<boolean> =>
  deliverInboundMessage({
    buildBody: (ctx) => ({
      html: buildMessageHtml(ctx, contactIntro(ctx.domain)),
      subject: `Contact form message from ${ctx.email}`,
      text: buildMessageText(ctx, contactIntro(ctx.domain)),
    }),
    email,
    message,
    recipient: settings.businessEmail,
    spoofsFromWarning: SPOOF_FROM_WARNING,
    spoofsRecipientWarning: SPOOF_BUSINESS_WARNING,
  });
