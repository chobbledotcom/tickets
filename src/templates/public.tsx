/**
 * Public page templates - home and ticket pages
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import type { EventWithCount } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { ticketFields } from "./fields.ts";
import { Layout } from "./layout.tsx";

/**
 * Home page
 */
export const homePage = (): string =>
  String(
    <Layout title="Ticket Reservation System">
      <h1>Ticket Reservation System</h1>
      <p>Welcome to the ticket reservation system.</p>
      <p><a href="/admin/">Admin Login</a></p>
    </Layout>
  );

/**
 * Public ticket page
 */
export const ticketPage = (event: EventWithCount, error?: string): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;

  return String(
    <Layout title={`Reserve Ticket: ${event.name}`}>
      <h1>{event.name}</h1>
      <p>{event.description}</p>
      <p><strong>Spots remaining:</strong> {spotsRemaining}</p>

      <Raw html={renderError(error)} />

      {isFull ? (
        <div class="error">Sorry, this event is full.</div>
      ) : (
        <form method="POST" action={`/ticket/${event.id}`}>
          <Raw html={renderFields(ticketFields)} />
          <button type="submit">Reserve Ticket</button>
        </form>
      )}
    </Layout>
  );
};

/**
 * Event not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title="Not Found">
      <h1>Event Not Found</h1>
      <p>The event you're looking for doesn't exist.</p>
    </Layout>
  );
