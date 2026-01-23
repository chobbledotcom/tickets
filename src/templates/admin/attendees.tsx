/**
 * Admin attendee page templates
 */

import type { Attendee, EventWithCount } from "#lib/types.ts";
import { Layout } from "../layout.tsx";

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  event: EventWithCount,
  attendee: Attendee,
  csrfToken: string,
  error?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <h1>Delete Attendee</h1>
      <p><a href={`/admin/event/${event.id}`}>&larr; Back to Event</a></p>

      {error && <div class="error">{error}</div>}

      <p style="color: #c00; font-weight: bold;">
        Warning: This will permanently remove this attendee from the event.
      </p>

      <h2>Attendee Details</h2>
      <p><strong>Name:</strong> {attendee.name}</p>
      <p><strong>Email:</strong> {attendee.email}</p>
      <p><strong>Quantity:</strong> {attendee.quantity}</p>
      <p><strong>Registered:</strong> {new Date(attendee.created).toLocaleString()}</p>

      <p>To delete this attendee, you must type their name "{attendee.name}" into the box below:</p>

      <form method="POST" action={`/admin/event/${event.id}/attendee/${attendee.id}/delete`}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <div class="field">
          <input
            type="text"
            name="confirm_name"
            placeholder={attendee.name}
            autocomplete="off"
            required
          />
        </div>
        <button
          type="submit"
          style="background: #c00; border-color: #900;"
        >
          Delete Attendee
        </button>
      </form>
    </Layout>
  );
