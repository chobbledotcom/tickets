/**
 * Admin QR scanner page template
 */

import { t } from "#i18n";
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
): string => {
  const messageTemplates = {
    alreadyCheckedIn: t("admin.scanner.already_checked_in", {
      name: "{name}",
      tickets: "{tickets}",
    }),
    checkedIn: t("admin.scanner.checked_in", {
      name: "{name}",
      tickets: "{tickets}",
    }),
    idMismatch: t("admin.scanner.id_mismatch", { name: "{name}" }),
    refunded: t("admin.scanner.refunded", { name: "{name}" }),
    skipped: t("admin.scanner.skipped", { name: "{name}" }),
    ticketCountOne: t("admin.scanner.ticket_count_one", { count: "{count}" }),
    ticketCountOther: t("admin.scanner.ticket_count_other", {
      count: "{count}",
    }),
    verifyIdConfirm: t("admin.scanner.verify_id_confirm", {
      name: "{name}",
    }),
    wrongListingConfirm: t("admin.scanner.wrong_listing_confirm", {
      listingName: "{listingName}",
      name: "{name}",
    }),
  };

  return String(
    <Layout
      headExtra={`<meta name="csrf-token" content="${getCurrentCsrfToken()}" /><script src="${SCANNER_JS_PATH}" defer></script>`}
      title={t("admin.scanner.title", { name: listing.name })}
    >
      <AdminNav active="/admin/" session={session} />
      <div class="prose">
        <h1>{t("admin.scanner.heading")}</h1>
        <p class="actions">
          <a href={`/admin/listing/${listing.id}`}>&larr; {listing.name}</a>
          <GuideLink href="/admin/guide#checkin">
            {t("admin.scanner.help")}
          </GuideLink>
        </p>
      </div>

      <article>
        <div
          data-message-already-checked-in={messageTemplates.alreadyCheckedIn}
          data-message-camera-denied={t("admin.scanner.camera_denied")}
          data-message-checked-in={messageTemplates.checkedIn}
          data-message-error={t("admin.scanner.error")}
          data-message-id-mismatch={messageTemplates.idMismatch}
          data-message-invalid-qr={t("admin.scanner.invalid_qr")}
          data-message-network-error={t("admin.scanner.network_error")}
          data-message-not-found={t("admin.scanner.not_found")}
          data-message-refunded={messageTemplates.refunded}
          data-message-scanning={t("admin.scanner.scanning")}
          data-message-skipped={messageTemplates.skipped}
          data-message-ticket-count-one={messageTemplates.ticketCountOne}
          data-message-ticket-count-other={messageTemplates.ticketCountOther}
          data-message-verify-id-confirm={messageTemplates.verifyIdConfirm}
          data-message-wrong-listing-confirm={
            messageTemplates.wrongListingConfirm
          }
          id="scanner-container"
        >
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
                aria-label={t("common.close")}
                id="scanner-confirm-close"
                type="button"
              >
                &times;
              </button>
              <p id="scanner-confirm-message"></p>
              <div class="scanner-confirm-actions">
                <button id="scanner-confirm-yes" type="button">
                  {t("common.yes")}
                </button>
                <button id="scanner-confirm-no" type="button">
                  {t("common.no")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <button id="scanner-start" type="button">
          {t("admin.scanner.start_camera")}
        </button>
      </article>

      <article>
        <h2>{t("admin.scanner.manual_checkin")}</h2>
        <form
          action={`/admin/listing/${listing.id}/scan`}
          data-listing-id={String(listing.id)}
          data-manual-checkin
          data-message-already-checked-in={messageTemplates.alreadyCheckedIn}
          data-message-checked-in={messageTemplates.checkedIn}
          data-message-error={t("admin.scanner.error")}
          data-message-network-error={t("admin.scanner.network_error")}
          data-message-not-found={t("admin.scanner.not_found")}
          data-message-refunded={messageTemplates.refunded}
          data-message-ticket-count-one={messageTemplates.ticketCountOne}
          data-message-ticket-count-other={messageTemplates.ticketCountOther}
          data-message-verify-id-note={t("admin.scanner.verify_id_note")}
          id="manual-checkin"
          method="POST"
        >
          <input
            name="csrf_token"
            type="hidden"
            value={getCurrentCsrfToken()}
          />
          <label for="manual-checkin-input">
            {t("admin.scanner.search_label")}
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
                  ? t("admin.scanner.tickets_available", {
                      count: uncheckedIn.length,
                    })
                  : t("admin.scanner.no_tickets")
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
              {uncheckedIn.map((ticket) => (
                <div
                  data-name={escapeHtml(ticket.name)}
                  data-quantity={String(ticket.quantity)}
                  data-token={ticket.token}
                  role="option"
                  tabIndex={0}
                >
                  {t("admin.scanner.ticket_option", {
                    count: ticket.quantity,
                    name: escapeHtml(ticket.name),
                    token: ticket.token,
                  })}
                </div>
              ))}
            </div>
          </div>
          <div class="hidden" id="manual-checkin-status"></div>
          <SubmitButton icon="check">
            {t("admin.scanner.check_in")}
          </SubmitButton>
        </form>
      </article>
    </Layout>,
  );
};
