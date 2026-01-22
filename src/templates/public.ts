/**
 * Public page templates - home and ticket pages
 */

import { renderError, renderFields } from "#lib/forms.ts";
import type { EventWithCount } from "#lib/types.ts";
import { ticketFields } from "./fields.ts";
import { escapeHtml, layout } from "./layout.ts";

/**
 * Home page
 */
export const homePage = (): string =>
  layout(
    "Ticket Reservation System",
    `
    <h1>Ticket Reservation System</h1>
    <p>Welcome to the ticket reservation system.</p>
    <p><a href="/admin/">Admin Login</a></p>
  `,
  );

/**
 * Public ticket page
 */
export const ticketPage = (event: EventWithCount, error?: string): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;

  return layout(
    `Reserve Ticket: ${event.name}`,
    `
    <h1>${escapeHtml(event.name)}</h1>
    <p>${escapeHtml(event.description)}</p>
    <p><strong>Spots remaining:</strong> ${spotsRemaining}</p>

    ${renderError(error)}

    ${
      isFull
        ? '<div class="error">Sorry, this event is full.</div>'
        : `
      <form method="POST" action="/ticket/${event.id}">
        ${renderFields(ticketFields)}
        <button type="submit">Reserve Ticket</button>
      </form>
    `
    }
  `,
  );
};

/**
 * Event not found page
 */
export const notFoundPage = (): string =>
  layout(
    "Not Found",
    `
    <h1>Event Not Found</h1>
    <p>The event you're looking for doesn't exist.</p>
  `,
  );
