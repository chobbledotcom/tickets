/**
 * Admin attendee page templates
 */

import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

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
