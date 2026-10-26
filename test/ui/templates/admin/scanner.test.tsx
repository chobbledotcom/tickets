import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

/** The hole names the scanner script fills in, spelled as the page carries
 * them between its own braces. */
const holes = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `{${name}}`]));

/** How many times a page carries one exact fragment. */
const times = (html: string, fragment: string): number =>
  html.split(fragment).length - 1;

/** The door cache key one test page carries, as the handler would pass it. */
const DOOR_CACHE_KEY = "test-door-cache-key";

/** The replay window one test page carries, as the handler would pass it. */
const RETENTION_DAYS = 7;

describe("the admin scanner page template", () => {
  beforeAll(setupAdminPageTest);

  test("points both checking paths at the door it scans for", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, "<title>Scanner: Doors</title>");
    assertStringIncludes(html, 'data-scan-path="/admin/groups/5/scan"');
    assertStringIncludes(html, 'action="/admin/groups/5/scan"');
    assert(!html.includes("Scanning a ticket in this group"));
  });

  test("offers the people still to arrive with their summed places", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [
        { attendeeId: 41, details: [], name: "Ada", quantity: 2 },
        { attendeeId: 42, details: [], name: "Sam", quantity: 1 },
      ],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, "2 tickets available");
    assertStringIncludes(html, 'data-name="Ada"');
    assertStringIncludes(html, 'data-quantity="2"');
    assertStringIncludes(html, 'data-attendee-id="41"');
    assertStringIncludes(html, 'data-name="Sam"');
  });

  test("tells two people with the same name apart by their day and listing", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [
        {
          attendeeId: 41,
          details: ["Camping · 12 Jun"],
          name: "Ada",
          quantity: 2,
        },
        {
          attendeeId: 42,
          details: ["Workshop · 14 Jun"],
          name: "Ada",
          quantity: 2,
        },
      ],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    // Same name and the same number of places: only the day, and on a
    // multi-listing door the listing, tells the two picks apart, so the
    // roster shows it beside the name.
    assertStringIncludes(html, "Ada (2 tickets) — Camping · 12 Jun");
    assertStringIncludes(html, "Ada (2 tickets) — Workshop · 14 Jun");
    assertStringIncludes(html, 'data-detail="Camping · 12 Jun"');
    // The pick list searches what it shows; it no longer offers the ticket
    // token, which the roster stopped carrying.
    assertStringIncludes(html, "Search by name, day, or listing");
    assert(!html.includes("ticket token"));
  });

  test("joins a several-place pick's details into one searchable line", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [
        {
          attendeeId: 43,
          details: ["Camping", "12 Jun"],
          name: "Ada",
          quantity: 2,
        },
      ],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, 'data-detail="Camping, 12 Jun"');
  });

  test("escapes a pick's name and day once, so the search reads the real words", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [
        {
          attendeeId: 41,
          details: ["Tom & Jerry <Show>"],
          name: "Ada & Bo",
          quantity: 1,
        },
      ],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, 'data-name="Ada &amp; Bo"');
    assertStringIncludes(html, 'data-detail="Tom &amp; Jerry &lt;Show&gt;"');
    assertStringIncludes(
      html,
      "Ada &amp; Bo (1 ticket) — Tom &amp; Jerry &lt;Show&gt;",
    );
    assert(!html.includes("&amp;amp;"));
  });

  test("says when nobody is left to check in", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, "No tickets to check in");
  });

  test("carries the door's cache key for the device, once", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    // The device digests a scan under this key. The page is the only
    // response that carries it, and it carries it once.
    assertStringIncludes(html, 'data-door-cache-key="test-door-cache-key"');
    expect(times(html, "data-door-cache-key=")).toBe(1);
  });

  test("carries the door's replay window for the device, once", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    // The client sends no queued check-in older than this window: past it
    // the server's replay record is gone. The page is the only response
    // that carries it, and it carries it once.
    assertStringIncludes(html, 'data-scan-operation-retention-days="7"');
    expect(times(html, "data-scan-operation-retention-days=")).toBe(1);
  });

  test("hands the queue count to a polite live region", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    // The sync rewrites the count in place; the live region is the only
    // announcement a screen reader gets, and it reads the count, not the
    // whole panel.
    assertStringIncludes(html, 'aria-live="polite"');
    expect(times(html, "aria-live=")).toBe(1);
  });

  test("one person still to arrive is named as one ticket, not none", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [{ attendeeId: 41, details: [], name: "Ada", quantity: 1 }],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    assertStringIncludes(html, "1 ticket available");
  });

  test("carries the check-every-listing warning as an alert, with no way to change it at the door", () => {
    // The flag, not the door's kind, draws the warning: the group's route
    // passes it only for a multi-listing door whose stored rule is on.
    const warned = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      true,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    assertStringIncludes(warned, 'role="alert"');
    assertStringIncludes(
      warned,
      "Scanning a ticket in this group will check in ALL of the attendee's booked listings in that group",
    );
    // The warning states the rule; it must not offer to change it at the door.
    assert(!warned.includes('name="scan_checks_in_all_listings"'));
    assert(!warned.includes('action="/admin/groups/5/scanner"'));

    const quiet = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    assert(!quiet.includes("Scanning a ticket in this group"));
  });

  test("carries every check-in message both checking paths read", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    /** One message the scanner script reads, with the exact holes the page
     * leaves between its braces. `carriedBy` says how many checking paths
     * must carry it: 2 for the shared set, 1 for a one-sided message. */
    const carried = (attr: string, value: string, carriedBy: 1 | 2): void => {
      expect(
        times(html, `data-message-${attr}="${escapeHtml(value)}"`),
        `data-message-${attr}`,
      ).toBe(carriedBy);
    };

    // The messages both the camera window and the manual pick-up read.
    carried(
      "already-checked-in",
      t(
        "admin.scanner.already_checked_in",
        holes("listingName", "name", "tickets"),
      ),
      2,
    );
    carried(
      "checked-in",
      t("admin.scanner.checked_in", holes("listingName", "name", "tickets")),
      2,
    );
    carried(
      "checked-in-partial",
      t(
        "admin.scanner.checked_in_partial",
        holes("listingName", "name", "tickets", "total"),
      ),
      2,
    );
    carried("error", t("admin.scanner.error"), 2);
    carried("network-error", t("admin.scanner.network_error"), 2);
    carried("not-found", t("admin.scanner.not_found"), 2);
    carried("refunded", t("admin.scanner.refunded", holes("name")), 2);
    carried(
      "select-quantity",
      t("admin.scanner.select_quantity", holes("name")),
      2,
    );
    carried("skipped", t("admin.scanner.skipped", holes("name")), 2);
    carried(
      "ticket-count-one",
      t("admin.scanner.ticket_count_one", holes("count")),
      2,
    );
    carried(
      "ticket-count-other",
      t("admin.scanner.ticket_count_other", holes("count")),
      2,
    );

    // The camera window's own messages.
    carried("camera-denied", t("admin.scanner.camera_denied"), 1);
    carried("id-mismatch", t("admin.scanner.id_mismatch", holes("name")), 1);
    carried("invalid-qr", t("admin.scanner.invalid_qr"), 1);
    carried("scanning", t("admin.scanner.scanning"), 1);
    carried(
      "verify-id-confirm",
      t("admin.scanner.verify_id_confirm", holes("name")),
      1,
    );
    carried(
      "wrong-listing-confirm",
      t("admin.scanner.wrong_listing_confirm", holes("listingName", "name")),
      1,
    );

    // The offline door's words, which the container carries once: the two
    // banner wordings, the quantity ask and its cancellation, the alert a
    // check-in that ran past the booking reads, a waiting row's words, and
    // the count's plurals.
    const carriedOnce = {
      "offline-banner-auto": t("admin.scanner.offline_banner_auto"),
      "offline-banner-manual": t("admin.scanner.offline_banner_manual"),
      "offline-not-queued": t("admin.scanner.offline_not_queued"),
      "offline-quantity-ask": t("admin.scanner.offline_quantity_ask"),
      "queue-count-one": t("admin.scanner.queue_count_one", holes("count")),
      "queue-count-other": t("admin.scanner.queue_count_other", holes("count")),
      "queue-item-expired": t("admin.scanner.queue_item_expired"),
      "queue-item-over-admitted": t(
        "admin.scanner.queue_item_over_admitted",
        holes("admitted", "bought", "name", "named"),
      ),
      "queue-item-queued": t("admin.scanner.queue_item_queued"),
    } as const;
    for (const [attr, value] of Object.entries(carriedOnce)) {
      carried(attr, value, 1);
    }

    // The manual pick-up's own messages.
    carried(
      "ticket-option",
      t("admin.scanner.ticket_option", holes("name", "tickets", "token")),
      1,
    );
    carried(
      "ticket-option-detail",
      t(
        "admin.scanner.ticket_option_detail",
        holes("detail", "name", "tickets"),
      ),
      1,
    );
    carried("verify-id-note", t("admin.scanner.verify_id_note"), 1);
  });

  test("draws the skeleton the scanner script drives", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    // The two asks the door puts before it admits: a forced or ID-checked
    // check-in, and how many tickets a multi-place booking admits.
    assertStringIncludes(
      html,
      'class="scanner-overlay hidden" id="scanner-confirm"',
    );
    assertStringIncludes(html, 'class="scanner-overlay-backdrop"');
    assertStringIncludes(html, 'class="scanner-overlay-box"');
    assertStringIncludes(html, 'id="scanner-confirm-close"');
    assertStringIncludes(html, 'id="scanner-confirm-message"');
    expect(times(html, 'class="scanner-confirm-actions"')).toBe(2);
    assertStringIncludes(html, 'id="scanner-confirm-yes"');
    assertStringIncludes(html, 'id="scanner-confirm-no"');
    assertStringIncludes(
      html,
      'class="scanner-overlay hidden" id="scanner-quantity"',
    );
    assertStringIncludes(html, 'id="scanner-start"');
    // The camera hole and status line the scanner script starts from, and
    // the quantity ask's controls.
    assertStringIncludes(html, 'id="scanner-container"');
    assertStringIncludes(html, 'id="scanner-video"');
    assertStringIncludes(html, 'id="scanner-status"');
    // The offline door: the banner the client raises and fills, and the
    // queue panel it keeps the kept scans in.
    assertStringIncludes(html, 'id="scanner-offline-banner"');
    assertStringIncludes(html, 'id="scanner-offline-banner-text"');
    assertStringIncludes(html, 'id="scanner-queue"');
    assertStringIncludes(html, 'id="scanner-queue-summary"');
    assertStringIncludes(html, 'id="scanner-queue-items"');
    assertStringIncludes(html, 'id="scanner-quantity-message"');
    assertStringIncludes(html, 'for="scanner-quantity-select"');
    assertStringIncludes(html, 'id="scanner-quantity-select"');
    assertStringIncludes(html, 'id="scanner-quantity-confirm"');
    assertStringIncludes(html, 'id="scanner-quantity-cancel"');
    // The /admin/ route is the home section's own landing link, so the nav
    // highlights it.
    assertStringIncludes(html, '<a class="active" href="/admin/">Home</a>');

    // The manual pick-up form.
    assertStringIncludes(html, 'id="manual-checkin"');
    assertStringIncludes(html, 'method="POST"');
    assertStringIncludes(html, 'name="csrf_token"');
    assertStringIncludes(html, 'for="manual-checkin-input"');
    assertStringIncludes(html, 'class="combobox"');
    assertStringIncludes(html, 'id="manual-checkin-attendee-id"');
    assertStringIncludes(html, 'name="attendee_id"');
    assertStringIncludes(html, 'autocomplete="off"');
    assertStringIncludes(html, 'id="manual-checkin-input"');
    assertStringIncludes(html, 'type="text"');
    assertStringIncludes(html, 'class="combobox-list hidden"');
    assertStringIncludes(html, 'id="ticket-options"');
    assertStringIncludes(html, 'id="manual-checkin-status"');
    // Two hidden fields: the form's own code, and the chosen person's
    // ticket; plus the five plainly hidden boxes the script reveals (the
    // offline banner, the queue panel, and the overlays carry their hidden
    // state inside a two-class attribute).
    expect(times(html, 'type="hidden"')).toBe(2);
    expect(times(html, 'class="hidden"')).toBe(5);

    // The way out to the guide.
    assertStringIncludes(html, 'href="/admin/guide#checkin"');
  });
});
