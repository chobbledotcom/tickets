/**
 * Admin QR scanner page template
 */

import { SCANNER_JS_PATH } from "#lib/asset-paths.ts";
import { getCurrentCsrfToken } from "#lib/csrf.ts";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Ticket option for the manual check-in autocomplete */
export interface TicketOption {
  token: string;
  name: string;
  quantity: number;
}

/**
 * Scanner page - camera feed with auto check-in + manual autocomplete
 */
export const adminScannerPage = (
  event: EventWithCount,
  session: AdminSession,
  uncheckedIn: TicketOption[] = [],
): string =>
  String(
    <Layout
      title={`Scanner: ${event.name}`}
      headExtra={`<meta name="csrf-token" content="${getCurrentCsrfToken()}" /><script src="${SCANNER_JS_PATH}" defer></script>`}
    >
      <AdminNav session={session} active="/admin/" />
      <h1>Scanner</h1>
      <p>
        <a href={`/admin/event/${event.id}`}>&larr; {event.name}</a>
      </p>

      <article>
        <div id="scanner-container">
          <video
            id="scanner-video"
            data-event-id={String(event.id)}
            playsinline
            muted
            class="hidden"
          ></video>
          <div id="scanner-status" class="hidden"></div>
          <div id="scanner-confirm" class="hidden">
            <div id="scanner-confirm-backdrop"></div>
            <div id="scanner-confirm-box">
              <button
                id="scanner-confirm-close"
                type="button"
                aria-label="Close"
              >
                &times;
              </button>
              <p id="scanner-confirm-message"></p>
              <div class="scanner-confirm-actions">
                <button id="scanner-confirm-yes" type="button">
                  Yes
                </button>
                <button id="scanner-confirm-no" type="button">
                  No
                </button>
              </div>
            </div>
          </div>
        </div>

        <button id="scanner-start" type="button">
          Start Camera
        </button>
      </article>

      <article>
        <h2>Manual Check-in</h2>
        <form
          id="manual-checkin"
          method="POST"
          action={`/admin/event/${event.id}/scan`}
          data-manual-checkin
          data-event-id={String(event.id)}
        >
          <input
            type="hidden"
            name="csrf_token"
            value={getCurrentCsrfToken()}
          />
          <label for="manual-checkin-input">
            Search by name or ticket token
          </label>
          <input
            id="manual-checkin-input"
            name="token"
            type="text"
            list="ticket-options"
            autocomplete="off"
            placeholder={
              uncheckedIn.length > 0
                ? `${uncheckedIn.length} tickets available`
                : "No tickets to check in"
            }
            required
          />
          <datalist id="ticket-options">
            {uncheckedIn.map((t) => (
              <option
                value={t.token}
                label={`${escapeHtml(t.name)} (${t.quantity} ticket${t.quantity === 1 ? "" : "s"})`}
              ></option>
            ))}
          </datalist>
          <div id="manual-checkin-status" class="hidden"></div>
          <button type="submit">Check In</button>
        </form>
      </article>
    </Layout>,
  );
