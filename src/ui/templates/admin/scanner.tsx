/**
 * Admin QR scanner page template
 */

import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { SCANNER_JS_PATH } from "#shared/asset-paths.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import { Layout } from "#templates/layout.tsx";
import type { AdminSession } from "#types";

/** Ticket option for the manual check-in autocomplete. It carries the
 * attendee's internal id, never the ticket credential. */
export interface TicketOption {
  attendeeId: number;
  name: string;
  quantity: number;
}

/** One door on the doors page: its name and the scanner page that serves it. */
export interface ScannerDoor {
  name: string;
  path: string;
}

/** The check-in message templates shared by both the camera scanner container
 *  and the manual-checkin form, as `data-message-*` attributes to spread onto
 *  each (each form then adds its own extra messages). Keeping the common set
 *  here stops the two attribute lists drifting apart. */
const sharedScanMessageAttrs = (messageTemplates: {
  alreadyCheckedIn: string;
  checkedIn: string;
  refunded: string;
  ticketCountOne: string;
  ticketCountOther: string;
}): Record<string, string> => ({
  "data-message-already-checked-in": messageTemplates.alreadyCheckedIn,
  "data-message-checked-in": messageTemplates.checkedIn,
  "data-message-error": t("admin.scanner.error"),
  "data-message-network-error": t("admin.scanner.network_error"),
  "data-message-not-found": t("admin.scanner.not_found"),
  "data-message-refunded": messageTemplates.refunded,
  "data-message-ticket-count-one": messageTemplates.ticketCountOne,
  "data-message-ticket-count-other": messageTemplates.ticketCountOther,
});

/** What one page's scanner messages say — every `{name}`-style hole below is
 * filled by the client from the scan API's answer. */
type ScannerMessages = {
  alreadyCheckedIn: string;
  checkedIn: string;
  idMismatch: string;
  refunded: string;
  skipped: string;
  noDoor: string;
  ticketCountOne: string;
  ticketCountOther: string;
  verifyIdConfirm: string;
  wrongListingConfirm: string;
};

const scannerMessages = (): ScannerMessages => ({
  alreadyCheckedIn: t("admin.scanner.already_checked_in", {
    listingName: "{listingName}",
    name: "{name}",
    tickets: "{tickets}",
  }),
  checkedIn: t("admin.scanner.checked_in", {
    listingName: "{listingName}",
    name: "{name}",
    tickets: "{tickets}",
  }),
  idMismatch: t("admin.scanner.id_mismatch", { name: "{name}" }),
  noDoor: t("admin.scanner.no_door"),
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
});

/** The shell both scanner pages wrap: the admin nav over the page's title.
 * The camera page adds its own script through `headExtra`. */
const scannerShell = (
  session: AdminSession,
  opts: { headExtra?: string | undefined; title: string },
  body: JSX.Element,
): string =>
  String(
    <Layout
      beforeContent={<AdminNav active="/admin/" session={session} />}
      headExtra={opts.headExtra}
      title={opts.title}
    >
      {body}
    </Layout>,
  );

/**
 * Scanner page - camera feed with auto check-in + manual autocomplete.
 * `subject` is whichever door this page scans for — a listing or a group —
 * and `scanPath` is the JSON API its two check-in paths post to. A group
 * whose stored door rule checks in every listing passes
 * `checksInEveryListing`, so door staff are warned what one scan will do.
 */
export const adminScannerPage = (
  subject: { name: string },
  scanPath: string,
  session: AdminSession,
  uncheckedIn: TicketOption[] = [],
  checksInEveryListing = false,
): string => {
  const messageTemplates = scannerMessages();

  return scannerShell(
    session,
    {
      headExtra: `<meta name="csrf-token" content="${getCurrentCsrfToken()}" /><script src="${SCANNER_JS_PATH}" type="module"></script>`,
      title: t("admin.scanner.title", { name: subject.name }),
    },
    <>
      <ProseHeading heading={t("admin.scanner.heading")} />

      <article>
        <div
          {...sharedScanMessageAttrs(messageTemplates)}
          data-message-camera-denied={t("admin.scanner.camera_denied")}
          data-message-id-mismatch={messageTemplates.idMismatch}
          data-message-invalid-qr={t("admin.scanner.invalid_qr")}
          data-message-no-door={messageTemplates.noDoor}
          data-message-scanning={t("admin.scanner.scanning")}
          data-message-skipped={messageTemplates.skipped}
          data-message-verify-id-confirm={messageTemplates.verifyIdConfirm}
          data-message-wrong-listing-confirm={
            messageTemplates.wrongListingConfirm
          }
          id="scanner-container"
        >
          <video
            class="hidden"
            data-scan-path={scanPath}
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

      {checksInEveryListing ? (
        <article>
          <aside role="alert">
            <p>{t("admin.scanner.scan_checks_in_all_listings_warning")}</p>
          </aside>
        </article>
      ) : undefined}

      <article>
        <h2>{t("admin.scanner.manual_checkin")}</h2>
        <form
          action={scanPath}
          {...sharedScanMessageAttrs(messageTemplates)}
          data-manual-checkin
          data-message-verify-id-note={t("admin.scanner.verify_id_note")}
          data-scan-path={scanPath}
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
            <input
              id="manual-checkin-attendee-id"
              name="attendee_id"
              type="hidden"
            />
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
                  data-attendee-id={String(ticket.attendeeId)}
                  data-name={escapeHtml(ticket.name)}
                  data-quantity={String(ticket.quantity)}
                  role="option"
                  tabIndex={0}
                >
                  {t("admin.scanner.ticket_option", {
                    count: ticket.quantity,
                    name: escapeHtml(ticket.name),
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
      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#checkin">
        {t("admin.scanner.help")}
      </GuideFooter>
    </>,
  );
};

/** One section of the doors page, or nothing when that kind of door has no
 *  doors — an empty heading promises a link that is not there. */
const doorsSection = (
  heading: string,
  doors: ScannerDoor[],
): JSX.Element | null =>
  doors.length === 0 ? null : (
    <article>
      <h2>{heading}</h2>
      <ul>
        {doors.map((door) => (
          <li>
            <a href={door.path}>{door.name}</a>
          </li>
        ))}
      </ul>
    </article>
  );

/** The doors page — a scanner login's landing page. It lists every door the
 *  role can work, so the person at the door can find tonight's scanner without
 *  asking for a link. */
export const adminScannerDoorsPage = (
  session: AdminSession,
  doors: { groupDoors: ScannerDoor[]; listingDoors: ScannerDoor[] },
): string => {
  const empty =
    doors.groupDoors.length === 0 && doors.listingDoors.length === 0;
  return scannerShell(
    session,
    { title: t("admin.scanner.doors_title") },
    <>
      <ProseHeading heading={t("admin.scanner.doors_heading")}>
        <p>{t("admin.scanner.doors_intro")}</p>
      </ProseHeading>
      {empty ? (
        <article>
          <p>{t("admin.scanner.doors_empty")}</p>
        </article>
      ) : (
        <>
          {doorsSection(t("terms.listings"), doors.listingDoors)}
          {doorsSection(t("terms.groups"), doors.groupDoors)}
        </>
      )}
    </>,
  );
};
