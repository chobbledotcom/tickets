/**
 * Send one email and report whether the provider accepted it.
 *
 * `email.ts` is imported on demand so callers on the every-request path (the
 * message forms, the superuser settings nag) don't drag the email rendering
 * stack into the eager cold-start graph.
 */

import type { EmailConfig, EmailMessage } from "#shared/email.ts";

/** Send an email via the configured provider, returning true on a 2xx status. */
export const sendEmailOk = async (
  config: EmailConfig,
  message: EmailMessage,
): Promise<boolean> => {
  const { sendEmail } = await import("#shared/email.ts");
  return (await sendEmail(config, message)).delivered;
};
