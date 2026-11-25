import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    expectIncludesAll(html, [
      "<title>Scanner: Doors</title>",
      'data-scan-path="/admin/groups/5/scan"',
    ]);
    expect(times(html, "data-scan-path=")).toBe(1);
    assert(!html.includes("Scanning a ticket in this group"));
  });

  test("draws an empty name search, with no person in the page", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );

    // The door asks the search route for a person by name, so the page
    // itself lists nobody.
    expectIncludesAll(html, [
      'placeholder="Type a name, then search"',
      "Search by name",
      'id="ticket-options"',
      'role="listbox"></div>',
    ]);
    assert(!html.includes('role="option"'));
    assert(!html.includes("data-attendee-id"));
  });

  test("carries the door's cache key for the device, once", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
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

  test("carries the check-every-listing warning as an alert, with no way to change it at the door", () => {
    // The flag, not the door's kind, draws the warning: the group's route
    // passes it only for a multi-listing door whose stored rule is on.
    const warned = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      true,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    expectIncludesAll(warned, [
      'role="alert"',
      "Scanning a ticket in this group will check in ALL of the attendee's booked listings in that group",
    ]);
    // The warning states the rule; it must not offer to change it at the door.
    assert(!warned.includes('name="scanChecksInAllListings"'));
    assert(!warned.includes('action="/admin/groups/5/scanner"'));

    const quiet = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    assert(!quiet.includes("Scanning a ticket in this group"));
  });

  test("a caller that omits the every-listing rule stays quiet, not warned", () => {
    // A one-listing door's route passes the flag itself; a direct caller
    // that leaves it out gets the safe default, never the warning.
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/listing/3/scan",
      OWNER_SESSION,
      undefined,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    assert(!html.includes("Scanning a ticket in this group"));
  });

  test("draws the skeleton the scanner script drives", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      false,
      DOOR_CACHE_KEY,
      RETENTION_DAYS,
    );
    // The two asks the door puts before it admits: a forced or ID-checked
    // check-in, and how many tickets a multi-place booking admits.
    expectIncludesAll(html, [
      'class="scanner-overlay hidden" id="scanner-confirm"',
      'class="scanner-overlay-backdrop"',
      'class="scanner-overlay-box"',
      'id="scanner-confirm-close"',
      'id="scanner-confirm-message"',
    ]);
    expect(times(html, 'class="scanner-confirm-actions"')).toBe(2);
    expectIncludesAll(html, [
      'id="scanner-confirm-yes"',
      'id="scanner-confirm-no"',
      'class="scanner-overlay hidden" id="scanner-quantity"',
      'id="scanner-start"',
      // The offline-mode toggle the client binds and the quiet button it keeps.
      'id="scanner-offline-toggle"',
      'class="link-button muted"',
      'aria-pressed="false"',
      // The camera hole and status line the scanner script starts from, and
      // the quantity ask's controls.
      'id="scanner-container"',
      'id="scanner-video"',
      'id="scanner-status"',
      // The offline door: the banner the client raises and fills, and the
      // queue panel it keeps the kept scans in.
      'id="scanner-offline-banner"',
      'id="scanner-offline-banner-text"',
      'id="scanner-queue"',
      'id="scanner-queue-summary"',
      'id="scanner-queue-items"',
      'id="scanner-quantity-message"',
      'for="scanner-quantity-select"',
      'id="scanner-quantity-select"',
      'id="scanner-quantity-confirm"',
      'id="scanner-quantity-cancel"',
      // The /admin/ route is the home section's own landing link, so the nav
      // highlights it.
      '<a class="active" href="/admin/">Home</a>',
      // The manual pick-up form.
      'id="manual-checkin"',
      'for="manual-checkin-input"',
      'class="combobox"',
      'id="manual-checkin-submit"',
      'autocomplete="off"',
      'id="manual-checkin-input"',
      'type="text"',
      'class="combobox-list hidden"',
      'id="ticket-options"',
      'id="manual-checkin-status"',
    ]);
    // No hidden field: the script reads the page's one CSRF meta and holds
    // the chosen person. The five plainly hidden boxes are the ones the
    // script reveals (the offline banner, the queue panel, and the overlays
    // carry their hidden state inside a two-class attribute).
    expect(times(html, 'type="hidden"')).toBe(0);
    expect(times(html, 'class="hidden"')).toBe(5);

    // The way out to the guide.
    assertStringIncludes(html, 'href="/admin/guide#checkin"');
  });
});
