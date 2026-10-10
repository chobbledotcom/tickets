/// <reference lib="dom" />
// test-groups: run-alone — the bundle runs inside happy-dom (see
// scanner.test.ts for the isolate note).

/**
 * The scanner bundle's messages on a page the operator's rebrand rendered:
 * I18N_REPLACEMENTS rewrites the rendered catalog copy (ticket to booking)
 * but never the bundle's hardcoded fallbacks, so the attribute copy a
 * lookup reaches is what the reader sees. These tests pin the rebranded
 * words the lookups must land on.
 */

import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  el,
  REBRANDED_PAGE,
  type ScannerHarness,
  useScannerSuite,
  whenTextShows,
} from "./fixture.ts";

describe("scanner messages under the ticket-to-booking rebrand", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite(REBRANDED_PAGE);

  /** Admit one ticket worth `quantity` of `total`, and wait for the status
   * line to show the rebranded copy. */
  const admitAndAwait = async (
    h: ScannerHarness,
    quantity: number,
    total: number,
    status: string,
  ): Promise<void> => {
    using _fetch = stubFetch(() =>
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity,
        remaining: 0,
        status: "checked_in",
        total,
      }),
    );
    const done = h.module.admitScan(
      "/admin/groups/5/scan",
      "tok",
      "csrf",
      h.statusEl,
      h.messages,
    );
    await whenTextShows(h.statusEl, status);
    await done;
  };

  test("says booking when the door does not know the ticket", async () => {
    const h = fresh();
    using _fetch = stubFetch(() => Response.json({ status: "not_found" }));

    const done = h.module.admitScan(
      "/admin/groups/5/scan",
      "tok",
      "csrf",
      h.statusEl,
      h.messages,
    );
    await whenTextShows(h.statusEl, "Booking not found");
    await done;
  });

  test("asks how many bookings at the quantity ask", async () => {
    const h = fresh();
    const bodies: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? Response.json({
            listingName: "Standard",
            name: "Ada",
            status: "wrong_listing",
          })
        : Response.json({ max: 3, name: "Ada", status: "select_quantity" });
    });

    const done = h.module.admitScan(
      "/admin/groups/5/scan",
      "tok",
      "csrf",
      h.statusEl,
      h.messages,
    );
    await whenTextShows(
      h.confirm.message,
      'Ada is registered for "Standard", not this listing. Check in anyway?',
    );
    h.confirm.yes.click();
    await whenTextShows(
      el(h.document, "scanner-quantity-message"),
      "How many bookings for Ada?",
    );
    el(h.document, "scanner-quantity-cancel").click();
    await done;
  });

  test("counts one booking on a one-ticket admit", async () => {
    await admitAndAwait(
      fresh(),
      1,
      1,
      "Ada checked in for Standard (1 booking)",
    );
  });

  test("counts bookings on a partial admit", async () => {
    await admitAndAwait(
      fresh(),
      1,
      2,
      "Ada checked in for Standard (1 of 2 bookings)",
    );
  });
});
