/**
 * Admin attendee page templates
 */

import { pipe, unique, map } from "#fp";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { formatCurrency } from "#lib/currency.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";

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
            <p><strong>Warning:</strong> This will permanently remove this attendee from the event and delete any associated payment records.</p>
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
          {Number.parseInt(attendee.price_paid, 10) > 0 && (
            <p><strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}</p>
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

/** Render event selector for edit attendee page */
const renderEventSelector = (
  currentEventId: number,
  allEvents: EventWithCount[],
): string => {
  // Get unique event IDs (current event + active events, uniquified)
  const eventIds = pipe(
    map((e: EventWithCount) => e.id),
    unique,
  )([{ id: currentEventId } as EventWithCount, ...allEvents]);

  // Build options HTML
  const options = eventIds
    .map((id) => {
      const event = allEvents.find((e) => e.id === id)!;
      const selected = id === currentEventId ? " selected" : "";
      return `<option value="${id}"${selected}>${event.name}${!event.active ? " (inactive)" : ""}</option>`;
    })
    .join("");

  return `<label for="event_id">Event<select id="event_id" name="event_id" required>${options}</select></label>`;
};

/**
 * Admin edit attendee page
 */
export const adminEditAttendeePage = (
  event: EventWithCount,
  attendee: Attendee,
  allEvents: EventWithCount[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Edit Attendee: ${attendee.name}`}>
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <h2>Edit Attendee</h2>

        <form method="POST" action={`/admin/attendees/${attendee.id}`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />

          <label for="name">
            Name
            <input
              type="text"
              id="name"
              name="name"
              value={attendee.name}
              required
              autofocus
            />
          </label>

          <label for="email">
            Email
            <input
              type="email"
              id="email"
              name="email"
              value={attendee.email || ""}
            />
          </label>

          <label for="phone">
            Phone
            <input
              type="text"
              id="phone"
              name="phone"
              value={attendee.phone || ""}
            />
          </label>

          <label for="address">
            Address
            <textarea
              id="address"
              name="address"
              rows={3}
            >{attendee.address || ""}</textarea>
          </label>

          <label for="special_instructions">
            Special Instructions
            <textarea
              id="special_instructions"
              name="special_instructions"
              rows={3}
            >{attendee.special_instructions || ""}</textarea>
          </label>

          <Raw html={renderEventSelector(event.id, allEvents)} />

          <button type="submit">Save Changes</button>
        </form>
    </Layout>
  );

/**
 * Admin re-send webhook confirmation page
 */
export const adminResendWebhookPage = (
  event: EventWithCount,
  attendee: Attendee,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Re-send Webhook: ${attendee.name}`}>
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Note:</strong> This will re-send the registration webhook for this attendee to all configured webhook URLs.</p>
          </aside>
        </article>

        <article>
          <h2>Attendee Details</h2>
          <p><strong>Name:</strong> {attendee.name}</p>
          <p><strong>Email:</strong> {attendee.email}</p>
          <p><strong>Quantity:</strong> {attendee.quantity}</p>
          {Number.parseInt(attendee.price_paid, 10) > 0 && (
            <p><strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}</p>
          )}
          <p><strong>Registered:</strong> {new Date(attendee.created).toLocaleString()}</p>
        </article>

        <p>To re-send the webhook for this attendee, you must type their name "{attendee.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/attendee/${attendee.id}/resend-webhook`}>
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
          <button type="submit">
            Re-send Webhook
          </button>
        </form>
    </Layout>
  );
