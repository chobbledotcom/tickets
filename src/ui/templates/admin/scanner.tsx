/**
 * Admin QR scanner page template
 */

import { SCANNER_JS_PATH } from "#shared/asset-paths.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink, SubmitButton } from "#templates/components/actions.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Ticket option for the manual check-in autocomplete */
export interface TicketOption {
  name: string;
  quantity: number;
  token: string;
}

/**
 * Scanner page - camera feed with auto check-in + manual autocomplete
 */
export const adminScannerPage = (
  listing: ListingWithCount,
  session: AdminSession,
  uncheckedIn: TicketOption[] = [],
): string =>
  String(
    <Layout
      headExtra={`<meta name="csrf-token" content="${getCurrentCsrfToken()}" /><script src="${SCANNER_JS_PATH}" defer></script>`}
      title={`Scanner: ${listing.name}`}
    >
      <AdminNav active="/admin/" session={session} />
      <div class="prose">
        <h1>Scanner</h1>
        <p class="actions">
          <a href={`/admin/listing/${listing.id}`}>&larr; {listing.name}</a>
          <GuideLink href="/admin/guide#checkin">Scanner help</GuideLink>
        </p>
      </div>

      <article>
        <div id="scanner-container">
          <video
            class="hidden"
            data-listing-id={String(listing.id)}
            id="scanner-video"
            muted
            playsinline
          ></video>
          <div class="hidden" id="scanner-status"></div>
          <div class="hidden" id="scanner-confirm">
            <div id="scanner-confirm-backdrop"></div>
            <div id="scanner-confirm-box">
              <button
                aria-label="Close"
                id="scanner-confirm-close"
                type="button"
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
          action={`/admin/listing/${listing.id}/scan`}
          data-listing-id={String(listing.id)}
          data-manual-checkin
          id="manual-checkin"
          method="POST"
        >
          <input
            name="csrf_token"
            type="hidden"
            value={getCurrentCsrfToken()}
          />
          <label for="manual-checkin-input">
            Search by name or ticket token
          </label>
          <div class="combobox">
            <input id="manual-checkin-token" name="token" type="hidden" />
            <input
              aria-autocomplete="list"
              aria-controls="ticket-options"
              aria-expanded="false"
              autocomplete="off"
              id="manual-checkin-input"
              placeholder={
                uncheckedIn.length > 0
                  ? `${uncheckedIn.length} tickets available`
                  : "No tickets to check in"
              }
              required
              role="combobox"
              type="text"
            />
            <div
              class="combobox-list hidden"
              id="ticket-options"
              role="listbox"
            >
              {uncheckedIn.map((t) => (
                <div
                  data-name={escapeHtml(t.name)}
                  data-quantity={String(t.quantity)}
                  data-token={t.token}
                  role="option"
                  tabIndex={0}
                >
                  {`${escapeHtml(t.name)} (${t.quantity} attendee${
                    t.quantity === 1 ? "" : "s"
                  }) — ${t.token}`}
                </div>
              ))}
            </div>
          </div>
          <div class="hidden" id="manual-checkin-status"></div>
          <SubmitButton icon="check">Check In</SubmitButton>
        </form>
      </article>
    </Layout>,
  );
