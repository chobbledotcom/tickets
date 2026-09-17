import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

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
        { name: "Ada", quantity: 2, token: "ada-token" },
        { name: "Sam", quantity: 1, token: "sam-token" },
      ],
    );

    expect(html).toContain("2 tickets available");
    expect(html).toContain('data-name="Ada"');
    expect(html).toContain('data-quantity="2"');
    expect(html).toContain('data-token="ada-token"');
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
});
