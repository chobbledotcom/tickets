import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  adminScannerDoorsPage,
  adminScannerPage,
} from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";
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

    says(html, "<title>Scanner: Doors</title>");
    says(html, 'data-scan-path="/admin/groups/5/scan"');
    says(html, 'action="/admin/groups/5/scan"');
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
    );

    says(html, "2 tickets available");
    says(html, 'data-name="Ada"');
    says(html, 'data-quantity="2"');
    says(html, 'data-attendee-id="41"');
    says(html, 'data-name="Sam"');
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
    );

    // Same name and the same number of places: only the day, and on a
    // multi-listing door the listing, tells the two picks apart, so the
    // roster shows it beside the name.
    says(html, "Ada (2 tickets) — Camping · 12 Jun");
    says(html, "Ada (2 tickets) — Workshop · 14 Jun");
    says(html, 'data-detail="Camping · 12 Jun"');
    // The pick list searches what it shows; it no longer offers the ticket
    // token, which the roster stopped carrying.
    says(html, "Search by name, day, or listing");
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
    );

    says(html, 'data-detail="Camping, 12 Jun"');
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
    );

    says(html, 'data-name="Ada &amp; Bo"');
    says(html, 'data-detail="Tom &amp; Jerry &lt;Show&gt;"');
    says(html, "Ada &amp; Bo (1 ticket) — Tom &amp; Jerry &lt;Show&gt;");
    assert(!html.includes("&amp;amp;"));
  });

  test("says when nobody is left to check in", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
    );

    says(html, "No tickets to check in");
  });

  test("one person still to arrive is named as one ticket, not none", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [{ attendeeId: 41, details: [], name: "Ada", quantity: 1 }],
    );

    says(html, "1 ticket available");
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
    says(warned, 'role="alert"');
    says(
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
    );
    assert(!quiet.includes("Scanning a ticket in this group"));
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
    );
    // The two asks the door puts before it admits: a forced or ID-checked
    // check-in, and how many tickets a multi-place booking admits.
    says(html, 'class="scanner-overlay hidden" id="scanner-confirm"');
    says(html, 'class="scanner-overlay-backdrop"');
    says(html, 'class="scanner-overlay-box"');
    says(html, 'id="scanner-confirm-close"');
    says(html, 'id="scanner-confirm-message"');
    expect(times(html, 'class="scanner-confirm-actions"')).toBe(2);
    says(html, 'id="scanner-confirm-yes"');
    says(html, 'id="scanner-confirm-no"');
    says(html, 'class="scanner-overlay hidden" id="scanner-quantity"');
    says(html, 'id="scanner-start"');
    // The camera hole and status line the scanner script starts from, and
    // the quantity ask's controls.
    says(html, 'id="scanner-container"');
    says(html, 'id="scanner-video"');
    says(html, 'id="scanner-status"');
    says(html, 'id="scanner-quantity-message"');
    says(html, 'for="scanner-quantity-select"');
    says(html, 'id="scanner-quantity-select"');
    says(html, 'id="scanner-quantity-confirm"');
    says(html, 'id="scanner-quantity-cancel"');
    // The /admin/ route is the home section's own landing link, so the nav
    // highlights it.
    says(html, '<a class="active" href="/admin/">Home</a>');

    // The manual pick-up form.
    says(html, 'id="manual-checkin"');
    says(html, 'method="POST"');
    says(html, 'name="csrf_token"');
    says(html, 'for="manual-checkin-input"');
    says(html, 'class="combobox"');
    says(html, 'id="manual-checkin-attendee-id"');
    says(html, 'name="attendee_id"');
    says(html, 'autocomplete="off"');
    says(html, 'id="manual-checkin-input"');
    says(html, 'type="text"');
    says(html, 'class="combobox-list hidden"');
    says(html, 'id="ticket-options"');
    says(html, 'id="manual-checkin-status"');
    // Two hidden fields: the form's own code, and the chosen person's
    // ticket; plus the three plainly hidden boxes the script reveals (the
    // overlays carry their hidden state inside a two-class attribute).
    expect(times(html, 'type="hidden"')).toBe(2);
    expect(times(html, 'class="hidden"')).toBe(3);

    // The way out to the guide.
    says(html, 'href="/admin/guide#checkin"');
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

    says(html, "<title>Scanner doors</title>");
    says(html, t("admin.scanner.doors_intro"));
    says(html, t("terms.listings"));
    says(html, t("terms.groups"));
    says(html, 'href="/admin/listings/3/scan">Ceilidh</a>');
    says(html, 'href="/admin/groups/7/scan">Winter Social</a>');
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

    says(html, t("terms.listings"));
    says(html, 'href="/admin/listings/3/scan">Ceilidh</a>');
    // An empty heading would promise a link that is not there.
    assert(!html.includes(t("terms.groups")));
  });

  test("lists the group doors alone when no listing has a door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [],
    });

    says(html, t("terms.groups"));
    says(html, 'href="/admin/groups/7/scan">Winter Social</a>');
    assert(!html.includes(t("terms.listings")));
  });

  test("says when there are no doors yet", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [],
    });

    says(html, t("admin.scanner.doors_empty"));
    assert(!html.includes(t("terms.listings")));
    assert(!html.includes(t("terms.groups")));
    // A door's path always ends in "/scan"; the empty doors page links to no
    // door (the nav's own /admin/scanner route is not a door).
    assert(!html.includes('href="/admin/listing/'));
    assert(!html.includes('href="/admin/groups/'));
  });

  test("the nav links a scanner back to the doors list", () => {
    // A scanner who opens a door from a bookmark still needs the route back
    // to /admin/scanner to pick another door: the role's only nav destination.
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "scanner" } }),
    );
    says(html, 'href="/admin/scanner"');
    says(html, ">Scanner</a>");
  });

  test("the nav offers the doors list to a scanner login only", () => {
    // Staff reach every door from its listing or group page, so the nav keeps
    // the link for the one role whose whole job it is.
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      assert(!html.includes('href="/admin/scanner"'));
    }
  });
});
