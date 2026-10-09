/**
 * Admin QR scanner page template
 */

import { t } from "#i18n";
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
  /** The door-safe facts that tell two people with the same name apart —
   * the listing (on a multi-listing door) and the day each place is for. */
  details: string[];
  name: string;
  quantity: number;
}

/** One door on the doors page: its name and the scanner page that serves it. */
export interface ScannerDoor {
  name: string;
  path: string;
}

/** What one page's scanner messages say — every `{name}`-style hole below is
 * filled by the client from the scan API's answer. */
type ScannerMessages = {
  alreadyCheckedIn: string;
  checkedIn: string;
  checkedInPartial: string;
  idMismatch: string;
  refunded: string;
  selectQuantity: string;
  noDoor: string;
  skipped: string;
  ticketCountOne: string;
  ticketCountOther: string;
  verifyIdConfirm: string;
  wrongListingConfirm: string;
};

/** The check-in message templates shared by both the camera scanner container
 *  and the manual-checkin form, as `data-message-*` attributes to spread onto
 *  each (each form then adds its own extra messages). Keeping the common set
 *  here stops the two attribute lists drifting apart. */
const sharedScanMessageAttrs = (
  messageTemplates: ScannerMessages,
): Record<string, string> => ({
  "data-message-already-checked-in": messageTemplates.alreadyCheckedIn,
  "data-message-checked-in": messageTemplates.checkedIn,
  "data-message-checked-in-partial": messageTemplates.checkedInPartial,
  "data-message-error": t("admin.scanner.error"),
  "data-message-network-error": t("admin.scanner.network_error"),
  "data-message-not-found": t("admin.scanner.not_found"),
  "data-message-refunded": messageTemplates.refunded,
  "data-message-select-quantity": messageTemplates.selectQuantity,
  "data-message-skipped": messageTemplates.skipped,
  "data-message-ticket-count-one": messageTemplates.ticketCountOne,
  "data-message-ticket-count-other": messageTemplates.ticketCountOther,
});

/** "1 ticket" or "3 tickets", worded the way the door's messages say it. */
export const ticketCountText = (count: number): string =>
  t(
    count === 1
      ? "admin.scanner.ticket_count_one"
      : "admin.scanner.ticket_count_other",
    { count },
  );

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
  checkedInPartial: t("admin.scanner.checked_in_partial", {
    listingName: "{listingName}",
    name: "{name}",
    tickets: "{tickets}",
    total: "{total}",
  }),
  idMismatch: t("admin.scanner.id_mismatch", { name: "{name}" }),
  noDoor: t("admin.scanner.no_door"),
  refunded: t("admin.scanner.refunded", { name: "{name}" }),
  selectQuantity: t("admin.scanner.select_quantity", { name: "{name}" }),
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

/** One centered overlay above the camera: backdrop, box, and the page's own
 * body. The confirm and the quantity asks share it, so both overlays keep the
 * same skeleton the client script centers. */
const ScannerOverlay = ({
  children,
  name,
}: {
  children: JSX.Element | JSX.Element[];
  name: string;
}): JSX.Element => (
  <div class="scanner-overlay hidden" id={`scanner-${name}`}>
    <div class="scanner-overlay-backdrop"></div>
    <div class="scanner-overlay-box">{children}</div>
  </div>
);

/** One overlay's action button, in the door's accept or plain variant. */
const OverlayButton = (
  id: string,
  label: string,
  variant: "primary" | "secondary" = "secondary",
): JSX.Element => (
  <button class={variant} id={id} type="button">
    {label}
  </button>
);
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
      family="admin"
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
          {ScannerOverlay({
            children: (
              <>
                <button
                  aria-label={t("common.close")}
                  id="scanner-confirm-close"
                  type="button"
                >
                  &times;
                </button>
                <p id="scanner-confirm-message"></p>
                <div class="scanner-confirm-actions">
                  {OverlayButton(
                    "scanner-confirm-yes",
                    t("common.yes"),
                    "primary",
                  )}
                  {OverlayButton("scanner-confirm-no", t("common.no"))}
                </div>
              </>
            ),
            name: "confirm",
          })}
          {ScannerOverlay({
            children: (
              <>
                <p id="scanner-quantity-message"></p>
                <label for="scanner-quantity-select">
                  {t("admin.scanner.quantity_label")}
                </label>
                <select id="scanner-quantity-select"></select>
                <div class="scanner-confirm-actions">
                  {OverlayButton(
                    "scanner-quantity-confirm",
                    t("admin.scanner.check_in"),
                    "primary",
                  )}
                  {OverlayButton("scanner-quantity-cancel", t("common.cancel"))}
                </div>
              </>
            ),
            name: "quantity",
          })}
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
          data-message-ticket-option={t("admin.scanner.ticket_option", {
            name: "{name}",
            tickets: "{tickets}",
          })}
          data-message-ticket-option-detail={t(
            "admin.scanner.ticket_option_detail",
            { detail: "{detail}", name: "{name}", tickets: "{tickets}" },
          )}
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
              {uncheckedIn.map((ticket) => {
                const detail = ticket.details.join(", ");
                return (
                  <div
                    data-attendee-id={String(ticket.attendeeId)}
                    data-detail={detail}
                    data-name={ticket.name}
                    data-quantity={String(ticket.quantity)}
                    role="option"
                    tabIndex={0}
                  >
                    {detail
                      ? t("admin.scanner.ticket_option_detail", {
                          detail,
                          name: ticket.name,
                          tickets: ticketCountText(ticket.quantity),
                        })
                      : t("admin.scanner.ticket_option", {
                          name: ticket.name,
                          tickets: ticketCountText(ticket.quantity),
                        })}
                  </div>
                );
              })}
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
