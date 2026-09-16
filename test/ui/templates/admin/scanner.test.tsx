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
    expect(html).not.toContain('id="scan-all-setting"');
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

  test("carries the check-in-every-listing box only for a spanning door", () => {
    const listing = adminScannerPage(
      { name: "One Door" },
      "/admin/listing/3/scan",
      OWNER_SESSION,
    );
    expect(listing).not.toContain('id="scan-all-setting"');

    const group = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      { checked: false, savePath: "/admin/groups/5/scanner" },
    );
    expect(group).toContain('id="scan-all-setting"');
    expect(group).toContain('action="/admin/groups/5/scanner"');
    const box = group.match(/<input[^>]*id="scan-all-listings"[^>]*>/)![0];
    expect(box).toContain('name="scan_checks_in_all_listings"');
    expect(box).toContain('type="checkbox"');
    expect(box).toContain('value="1"');
    expect(box).not.toContain("checked");
    expect(group).toContain(
      "Check in every listing in this group when scanning any",
    );

    const ticked = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      { checked: true, savePath: "/admin/groups/5/scanner" },
    );
    expect(
      ticked.match(/<input[^>]*id="scan-all-listings"[^>]*>/)![0],
    ).toContain("checked");
  });
});
