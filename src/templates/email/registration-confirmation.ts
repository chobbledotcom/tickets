/**
 * Registration confirmation email template (sent to attendee)
 */

import { type EmailContent, eventNames, type RegistrationEntry, ticketRow, ticketRowHtml } from "#templates/email/shared.ts";

export const registrationConfirmation = (
  entries: RegistrationEntry[],
  _currency: string,
  ticketUrl: string,
): EmailContent => {
  const names = eventNames(entries);
  const subject = `Your tickets for ${names}`;

  const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>Thanks for registering!</h2>
<p>You're confirmed for <strong>${names}</strong>.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Event</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
${entries.map(ticketRowHtml).join("\n")}
</table>
<p><a href="${ticketUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px">View your tickets</a></p>
<p style="color:#666;font-size:14px">Or copy this link: ${ticketUrl}</p>
</div>`;

  const text = `Thanks for registering!

You're confirmed for ${names}.

${entries.map(ticketRow).join("\n")}

View your tickets: ${ticketUrl}`;

  return { subject, html, text };
};
