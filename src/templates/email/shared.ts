/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import { isPaidEvent } from "#lib/types.ts";
import type { RegistrationEntry } from "#lib/webhook.ts";
export type { RegistrationEntry };

export type EmailContent = { subject: string; html: string; text: string };

export const eventNames = (entries: RegistrationEntry[]): string =>
  map(({ event }: RegistrationEntry) => event.name)(entries).join(" and ");

export const ticketRow = ({ event, attendee }: RegistrationEntry): string => {
  const price = isPaidEvent(event) ? ` — ${formatCurrency(attendee.price_paid)}` : "";
  const date = attendee.date ? ` (${attendee.date})` : "";
  return `${event.name}${date}: ${attendee.quantity} ticket${attendee.quantity > 1 ? "s" : ""}${price}`;
};

export const ticketRowHtml = ({ event, attendee }: RegistrationEntry): string => {
  const price = isPaidEvent(event) ? `<td>${formatCurrency(attendee.price_paid)}</td>` : "<td></td>";
  const date = attendee.date ? ` <small>(${attendee.date})</small>` : "";
  return `<tr><td>${event.name}${date}</td><td>${attendee.quantity}</td>${price}</tr>`;
};
