/// <reference lib="dom" />
// test-groups: run-alone — the bundle runs inside happy-dom (see
// scanner.test.ts for the isolate note).

/**
 * The scanner bundle's messages on a page the operator's rebrand rendered:
 * I18N_REPLACEMENTS rewrites the rendered catalog copy (ticket to booking),
 * and the page sends that copy as its words. These tests pin the rebranded
 * words the bundle shows.
 */

import { expect } from "@std/expect";
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

  /** Admit one ticket worth `quantity` of `total`, and answer the words
   * the status line shows. */
  const admittedWords = async (
    h: ScannerHarness,
    quantity: number,
    total: number,
  ): Promise<string> => {
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
    await h.module.admitScan(
      "/admin/groups/5/scan",
      "tok",
      "csrf",
      h.say,
      h.wording,
    );
    return String(h.statusEl.textContent);
  };

  test("says booking when the door does not know the ticket", async () => {
    const h = fresh();
    using _fetch = stubFetch(() => Response.json({ status: "not_found" }));

    await h.module.admitScan(
      "/admin/groups/5/scan",
      "tok",
      "csrf",
      h.say,
      h.wording,
    );
    expect(h.statusEl.textContent).toBe(
      "This booking was not found. Check that it is for this event.",
    );
  });

  test("says booking when the ticket has no door at all", () => {
    const h = fresh();

    h.module.sayAnswer(
      { listingName: "Standard", name: "Ada", status: "wrong_listing" },
      h.wording,
      h.say,
    );

    expect(h.statusEl.textContent).toBe(
      "This booking has no door to check in at.",
    );
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
      h.say,
      h.wording,
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
    expect(el(h.document, "scanner-quantity-message").textContent).toBe(
      "How many bookings for Ada?",
    );
    el(h.document, "scanner-quantity-cancel").click();
    await done;
  });

  test("counts one booking on a one-ticket admit", async () => {
    expect(await admittedWords(fresh(), 1, 1)).toBe(
      "Ada checked in for Standard (1 booking)",
    );
  });

  test("counts bookings on a partial admit", async () => {
    expect(await admittedWords(fresh(), 1, 2)).toBe(
      "Ada checked in for Standard (1 of 2 bookings)",
    );
  });
});
