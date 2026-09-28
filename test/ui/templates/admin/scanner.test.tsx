import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import {
  adminScannerDoorsPage,
  adminScannerPage,
} from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import type { AdminSession } from "#types";

/** The hole names the scanner script fills in, spelled as the page carries
 * them between its own braces. */
const holes = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `{${name}}`]));

/** How many times a page carries one exact fragment. */
const times = (html: string, fragment: string): number =>
  html.split(fragment).length - 1;

describe("the admin scanner page template", () => {
  beforeAll(setupAdminPageTest);

  test("points both checking paths at the door it scans for", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
    );

    expect(html).toContain("<title>Scanner: Doors</title>");
    expect(html).toContain('data-scan-path="/admin/groups/5/scan"');
    expect(html).toContain('action="/admin/groups/5/scan"');
    expect(html).not.toContain("Scanning a ticket in this group");
  });

  test("offers the people still to arrive with their summed places", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [
        { attendeeId: 41, name: "Ada", quantity: 2 },
        { attendeeId: 42, name: "Sam", quantity: 1 },
      ],
    );

    expect(html).toContain("2 tickets available");
    expect(html).toContain('data-name="Ada"');
    expect(html).toContain('data-quantity="2"');
    expect(html).toContain('data-attendee-id="41"');
    expect(html).toContain('data-name="Sam"');
  });

  test("says when nobody is left to check in", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
    );

    expect(html).toContain("No tickets to check in");
  });

  test("one person still to arrive is named as one ticket, not none", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [{ attendeeId: 41, name: "Ada", quantity: 1 }],
    );

    expect(html).toContain("1 ticket available");
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
    );
    expect(warned).toContain('role="alert"');
    expect(warned).toContain(
      "Scanning a ticket in this group will check in ALL of the attendee's booked listings in that group",
    );
    // The warning states the rule; it must not offer to change it at the door.
    expect(warned).not.toContain('name="scan_checks_in_all_listings"');
    expect(warned).not.toContain('action="/admin/groups/5/scanner"');

    const quiet = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
    );
    expect(quiet).not.toContain("Scanning a ticket in this group");
  });

  test("carries every check-in message both checking paths read", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
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
    carried("error", t("admin.scanner.error"), 2);
    carried("network-error", t("admin.scanner.network_error"), 2);
    carried("not-found", t("admin.scanner.not_found"), 2);
    carried("refunded", t("admin.scanner.refunded", holes("name")), 2);
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
    carried("skipped", t("admin.scanner.skipped", holes("name")), 1);
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

    // The manual pick-up's own note.
    carried("verify-id-note", t("admin.scanner.verify_id_note"), 1);
  });

  test("draws the skeleton the scanner script drives", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
    );

    expect(html).toContain('<div class="prose">');
    // The admin nav marks Home as this page's own tab.
    expect(html).toContain('<a class="active" href="/admin/">Home</a>');

    // The camera window, its video, and its status line.
    expect(html).toContain('id="scanner-container"');
    expect(html).toContain('id="scanner-video"');
    expect(html).toContain('id="scanner-status"');
    expect(html).toContain("<video");
    expect(html).toContain(" muted");
    expect(html).toContain(" playsinline");

    // The question the door asks before a forced or ID-checked check-in.
    expect(html).toContain('id="scanner-confirm"');
    expect(html).toContain('id="scanner-confirm-backdrop"');
    expect(html).toContain('id="scanner-confirm-box"');
    expect(html).toContain('id="scanner-confirm-close"');
    expect(html).toContain('id="scanner-confirm-message"');
    expect(html).toContain('class="scanner-confirm-actions"');
    expect(html).toContain('id="scanner-confirm-yes"');
    expect(html).toContain('id="scanner-confirm-no"');

    expect(html).toContain('id="scanner-start"');

    // The manual pick-up form.
    expect(html).toContain('id="manual-checkin"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain('for="manual-checkin-input"');
    expect(html).toContain('class="combobox"');
    expect(html).toContain('id="manual-checkin-attendee-id"');
    expect(html).toContain('name="attendee_id"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('id="manual-checkin-input"');
    expect(html).toContain('type="text"');
    expect(html).toContain('class="combobox-list hidden"');
    expect(html).toContain('id="ticket-options"');
    expect(html).toContain('id="manual-checkin-status"');
    // Two hidden fields: the form's own code, and the chosen person's
    // ticket; plus the four plainly hidden boxes the script reveals.
    expect(times(html, 'type="hidden"')).toBe(2);
    expect(times(html, 'class="hidden"')).toBe(4);

    // The way out to the guide.
    expect(html).toContain('href="/admin/guide#checkin"');
  });
});

describe("the admin scanner doors page template", () => {
  beforeAll(setupAdminPageTest);

  /** The doors page serves a scanner login, whose nav carries no other
   *  section's words for the assertions below to trip over. */
  const SCANNER_SESSION: AdminSession = { adminLevel: "scanner" };

  test("lists every door under its kind, as a link to the door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [{ name: "Ceilidh", path: "/admin/listings/3/scan" }],
    });

    expect(html).toContain("<title>Scanner doors</title>");
    expect(html).toContain(t("admin.scanner.doors_intro"));
    expect(html).toContain(t("terms.listings"));
    expect(html).toContain(t("terms.groups"));
    expect(html).toContain('href="/admin/listings/3/scan">Ceilidh</a>');
    expect(html).toContain('href="/admin/groups/7/scan">Winter Social</a>');
    // The listings section is announced before the groups section.
    expect(html.indexOf(t("terms.listings"))).toBeLessThan(
      html.indexOf(t("terms.groups")),
    );
  });

  test("leaves out the kind of door that has none", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [{ name: "Ceilidh", path: "/admin/listings/3/scan" }],
    });

    expect(html).toContain(t("terms.listings"));
    expect(html).toContain('href="/admin/listings/3/scan">Ceilidh</a>');
    // An empty heading would promise a link that is not there.
    expect(html).not.toContain(t("terms.groups"));
  });

  test("lists the group doors alone when no listing has a door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [],
    });

    expect(html).toContain(t("terms.groups"));
    expect(html).toContain('href="/admin/groups/7/scan">Winter Social</a>');
    expect(html).not.toContain(t("terms.listings"));
  });

  test("says when there are no doors yet", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [],
    });

    expect(html).toContain(t("admin.scanner.doors_empty"));
    expect(html).not.toContain(t("terms.listings"));
    expect(html).not.toContain(t("terms.groups"));
    // A door's path always ends in "/scan"; the empty doors page links to no
    // door (the nav's own /admin/scanner route is not a door).
    expect(html).not.toContain('href="/admin/listing/');
    expect(html).not.toContain('href="/admin/groups/');
  });
});
