/**
 * Admin QR scanner page template
 */

import { t, tWithHoles } from "#i18n";
import { SCANNER_JS_PATH } from "#shared/asset-paths.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { SCANNER_WORDS, type ScannerWords } from "#shared/scanner-words.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import { Layout } from "#templates/layout.tsx";
import type { AdminSession } from "#types";

/** One door on the doors page: its name and the scanner page that serves it. */
export interface ScannerDoor {
  name: string;
  path: string;
}

/** "1 ticket" or "3 tickets", worded the way the door's messages say it. */
export const ticketCountText = (count: number): string =>
  t(
    count === 1
      ? "admin.scanner.ticket_count_one"
      : "admin.scanner.ticket_count_other",
    { count },
  );

/** Every word the page's browser code shows, filled from the catalog with
 * each hole left as `{hole}`. */
const scannerWords = (): ScannerWords =>
  Object.fromEntries(
    Object.entries(SCANNER_WORDS).map(([name, { holes, key }]) => [
      name,
      tWithHoles(key, ...holes),
    ]),
  ) as ScannerWords;

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

/** The routes one door's page talks to: the scan, its offline list, and
 * its name search. */
export type DoorPaths = { cache: string; scan: string; search: string };

/**
 * Scanner page - camera feed with auto check-in + manual check-in by name.
 * `subject` is whichever door this page scans for — a listing or a group.
 * `paths` are the routes it talks to: the scan API that both check-in
 * paths post to, its offline list, and its name search. A group
 * whose stored door rule checks in every listing passes
 * `checksInEveryListing`, so door staff are warned what one scan will do.
 * `doorCacheKey` is the door's offline cache key, base64url: the device
 * digests a scanned token under it. The cache response itself never
 * carries the key. `scanOperationRetentionDays` is the door's replay
 * window in days: how long the server keeps one queued check-in's
 * delivery record. The client sends no queued check-in older than it.
 */
export const adminScannerPage = (
  subject: { name: string },
  paths: DoorPaths,
  session: AdminSession,
  checksInEveryListing = false,
  doorCacheKey: string,
  scanOperationRetentionDays: number,
): string =>
  scannerShell(
    session,
    {
      headExtra: `<meta name="csrf-token" content="${getCurrentCsrfToken()}" /><script src="${SCANNER_JS_PATH}" type="module"></script>`,
      title: t("admin.scanner.title", { name: subject.name }),
    },
    <>
      <ProseHeading heading={t("admin.scanner.heading")} />

      <article>
        <div
          data-door-cache-key={doorCacheKey}
          data-scan-cache-path={paths.cache}
          data-scan-operation-retention-days={String(
            scanOperationRetentionDays,
          )}
          data-scan-path={paths.scan}
          data-scan-search-path={paths.search}
          data-words={JSON.stringify(scannerWords())}
          id="scanner-container"
        >
          <aside class="hidden" id="scanner-offline-banner" role="status">
            <p id="scanner-offline-banner-text"></p>
          </aside>
          <video class="hidden" id="scanner-video" muted playsinline></video>
          <div class="hidden" id="scanner-status"></div>
          <div class="hidden" id="scanner-queue">
            <p aria-live="polite" id="scanner-queue-summary"></p>
            <ul id="scanner-queue-items"></ul>
          </div>
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
        <button
          aria-pressed="false"
          class="link-button muted"
          id="scanner-offline-toggle"
          type="button"
        >
          {t("admin.scanner.offline_mode")}
        </button>
        <p class="muted hidden" id="scanner-offline-progress" role="status"></p>
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
        <form id="manual-checkin">
          <label for="manual-checkin-input">
            {t("admin.scanner.search_label")}
          </label>
          <div class="combobox">
            <input
              aria-autocomplete="list"
              aria-controls="ticket-options"
              aria-expanded="false"
              autocomplete="off"
              id="manual-checkin-input"
              placeholder={t("admin.scanner.search_placeholder")}
              required
              role="combobox"
              type="text"
            />
            <div
              class="combobox-list hidden"
              id="ticket-options"
              role="listbox"
            ></div>
          </div>
          <div class="hidden" id="manual-checkin-status"></div>
          <SubmitButton icon="search" id="manual-checkin-submit">
            {t("admin.scanner.search_button")}
          </SubmitButton>
        </form>
      </article>
      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#checkin">
        {t("admin.scanner.help")}
      </GuideFooter>
    </>,
  );

/** One section of the doors page, or nothing when that kind of door has no
 *  doors. An empty heading promises a link that is not there. */
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
          <div class="prose">
            <p>{t("admin.scanner.doors_empty")}</p>
          </div>
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
