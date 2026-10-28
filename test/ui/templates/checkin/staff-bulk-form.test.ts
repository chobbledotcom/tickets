/** The staff bulk form on the check-in page a staff login reads: one hidden
 * field whose name and value are what the POST route reads, flipping between
 * admit and checkout as the rows come in. The door-only view's forms live in
 * scanner-rendering.test.ts; this renders the staff page's own template. */

import { assert, assertStringIncludes } from "@std/assert";
import { it as bddTest, describe } from "@std/testing/bdd";
import { pairKey } from "#booking/ticket-moves.ts";
import { checkinAdminPage } from "#templates/checkin.tsx";
import { withCsrfRequest } from "#test-utils/csrf-request.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

const test = (name: string, body: () => void | Promise<void>): void => {
  bddTest(name, () => withCsrfRequest(body));
};

/** The staff view of GET /checkin/:tokens: check-in allowed, staff (not
 * door-only) affordances, links to the admin pages. */
const STAFF_PAGE_OPTIONS = {
  canCheckIn: true,
  doorOnly: false,
  linkAdminPages: true,
} as const;

describe("the staff bulk form on the check-in admin page", () => {
  test("admits with the true spelling while a row still waits", () => {
    const html = checkinAdminPage(
      [testTokenEntry()],
      new Map([[pairKey(1, 1), { checked_in: 0, quantity: 1 }]]),
      "/checkin/test-token-1",
      "",
      "example.com",
      undefined,
      STAFF_PAGE_OPTIONS,
    );

    // The hidden field's name and value are exactly what the POST reads
    // (form.get("check_in") === "true"): admit means the true spelling.
    assertStringIncludes(html, 'class="bulk-checkin"');
    assertStringIncludes(html, 'name="check_in" type="hidden" value="true"');
    assert(!html.includes("bulk-checkout"));
  });

  test("offers checkout with the false spelling once every row is in", () => {
    const html = checkinAdminPage(
      [testTokenEntry({ attendee: { checked_in: 1, quantity: 1 } })],
      new Map([[pairKey(1, 1), { checked_in: 1, quantity: 1 }]]),
      "/checkin/test-token-1",
      "",
      "example.com",
      undefined,
      STAFF_PAGE_OPTIONS,
    );

    // The flipped action submits the false spelling — any other value would
    // read as another admit and re-check the rows instead of undoing them.
    assertStringIncludes(html, 'class="bulk-checkout"');
    assertStringIncludes(html, 'name="check_in" type="hidden" value="false"');
    assert(!html.includes('value="true"'));
  });
});
