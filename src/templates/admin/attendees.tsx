/**
 * Admin attendee page templates
 */

import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/** Format cents as a display string (e.g. 2999 -> "29.99") */
const formatPrice = (cents: string): string =>
  (Number.parseInt(cents, 10) / 100).toFixed(2);

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  event: EventWithCount,
  attendee: Attendee,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> This will permanently remove this attendee from the event.</p>
          </aside>
        </article>

        <article>
          <h2>Attendee Details</h2>
          <p><strong>Name:</strong> {attendee.name}</p>
          <p><strong>Email:</strong> {attendee.email}</p>
          <p><strong>Quantity:</strong> {attendee.quantity}</p>
          <p><strong>Registered:</strong> {new Date(attendee.created).toLocaleString()}</p>
        </article>

        <p>To delete this attendee, you must type their name "{attendee.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/attendee/${attendee.id}/delete`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <label for="confirm_name">Attendee name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={attendee.name}
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Delete Attendee
          </button>
        </form>
    </Layout>
  );

/**
 * Admin refund attendee confirmation page
 */
export const adminRefundAttendeePage = (
  event: EventWithCount,
  attendee: Attendee,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Refund Attendee: ${attendee.name}`}>
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> This will issue a full refund for this attendee's payment. The attendee will remain registered.</p>
          </aside>
        </article>

        <article>
          <h2>Attendee Details</h2>
          <p><strong>Name:</strong> {attendee.name}</p>
          <p><strong>Email:</strong> {attendee.email}</p>
          <p><strong>Quantity:</strong> {attendee.quantity}</p>
          {attendee.price_paid && (
            <p><strong>Amount Paid:</strong> {formatPrice(attendee.price_paid)}</p>
          )}
          <p><strong>Registered:</strong> {new Date(attendee.created).toLocaleString()}</p>
        </article>

        <p>To refund this attendee, you must type their name "{attendee.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/attendee/${attendee.id}/refund`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <label for="confirm_name">Attendee name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={attendee.name}
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Refund Attendee
          </button>
        </form>
    </Layout>
  );

/**
 * Admin refund all attendees confirmation page
 */
export const adminRefundAllAttendeesPage = (
  event: EventWithCount,
  refundableCount: number,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Refund All: ${event.name}`}>
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> This will issue a full refund for all {refundableCount} attendee(s) with payments. Attendees will remain registered.</p>
          </aside>
        </article>

        <p>To refund all attendees, you must type the event name "{event.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/refund-all`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <label for="confirm_name">Event name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={event.name}
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Refund All Attendees
          </button>
        </form>
    </Layout>
  );
