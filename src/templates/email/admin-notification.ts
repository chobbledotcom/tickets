/**
 * Admin notification email template (sent to business email)
 */

import { type EmailContent, eventNames, type RegistrationEntry, ticketRow, ticketRowHtml } from "#templates/email/shared.ts";

export const adminNotification = (
  entries: RegistrationEntry[],
  _currency: string,
): EmailContent => {
  const first = entries[0]!;
  const names = eventNames(entries);
  const subject = `New registration: ${first.attendee.name} for ${names}`;

  const contactLines = [
    `Name: ${first.attendee.name}`,
    first.attendee.email ? `Email: ${first.attendee.email}` : "",
    first.attendee.phone ? `Phone: ${first.attendee.phone}` : "",
    first.attendee.address ? `Address: ${first.attendee.address}` : "",
    first.attendee.special_instructions ? `Notes: ${first.attendee.special_instructions}` : "",
  ].filter(Boolean);

  const contactHtml = contactLines.map((l) => `<li>${l}</li>`).join("");

  const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>New registration</h2>
<ul style="list-style:none;padding:0">${contactHtml}</ul>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Event</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
${entries.map(ticketRowHtml).join("\n")}
</table>
</div>`;

  const text = `New registration

${contactLines.join("\n")}

${entries.map(ticketRow).join("\n")}`;

  return { subject, html, text };
};
