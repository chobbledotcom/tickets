/**
 * Public page templates - home and ticket pages
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import type { EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { ticketFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Home page
 */
export const homePage = (): string =>
  String(
    <Layout title="Ticket Reservation System">
      <header>
        <h1>Ticket Reservation System</h1>
        <p>Welcome to the ticket reservation system.</p>
        <nav>
          <a href="/admin/"><b>Admin Login</b></a>
        </nav>
      </header>
    </Layout>
  );

/**
 * Build quantity select options
 */
const quantityOptions = (max: number): string =>
  Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<option value="${n}">${n}</option>`)
    .join("");

/**
 * Public ticket page
 */
export const ticketPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;
  const maxPurchasable = Math.min(event.max_quantity, spotsRemaining);
  const showQuantity = maxPurchasable > 1;

  return String(
    <Layout title={`Reserve Ticket: ${event.name}`}>
      <header>
        <h1>{event.name}</h1>
        <p>{event.description}</p>
      </header>

      <section>
        <aside>
          <p><strong>Spots remaining:</strong> {spotsRemaining}</p>
        </aside>
      </section>

      <Raw html={renderError(error)} />

      {isFull ? (
        <section>
          <div class="error">Sorry, this event is full.</div>
        </section>
      ) : (
        <section>
          <form method="POST" action={`/ticket/${event.slug}`}>
            <header>
              <h2>Reserve Your Ticket</h2>
            </header>
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <Raw html={renderFields(ticketFields)} />
            {showQuantity ? (
              <>
                <label for="quantity">Number of Tickets</label>
                <select name="quantity" id="quantity">
                  <Raw html={quantityOptions(maxPurchasable)} />
                </select>
              </>
            ) : (
              <input type="hidden" name="quantity" value="1" />
            )}
            <button type="submit">Reserve Ticket{showQuantity ? "s" : ""}</button>
          </form>
        </section>
      )}
    </Layout>
  );
};

/**
 * Not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title="Not Found">
      <h1>Not Found</h1>
    </Layout>
  );
