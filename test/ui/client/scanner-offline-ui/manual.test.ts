/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/** The manual check-in on the scanner page, driven through the real built
 * bundle: while offline mode settles the door, a search by name reads the
 * saved list and a pick joins the offline queue. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  savedEntry,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  MODE_KEY,
  SCAN_PATH,
  SCANNER_PAGE,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  digestOf,
  expectOneStoredCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** The manual check-in form the scanner page renders below the camera. */
const MANUAL_FORM = `
  <form
    data-manual-checkin
    data-message-check-in-button="Check In"
    data-message-search-button="Search"
    data-message-search-failed="The search did not work. Check your connection, then try again."
    data-message-search-none="Nobody at this door matches that name."
    data-message-search-too-short="Type at least 2 letters of the name."
    data-message-ticket-count-one="{count} ticket"
    data-message-ticket-count-other="{count} tickets"
    data-message-ticket-option="{name} ({tickets})"
    data-message-ticket-option-detail="{name} ({tickets}) — {detail}"
    data-scan-path="${SCAN_PATH}"
    id="manual-checkin"
    method="POST"
  >
    <input name="csrfToken" type="hidden" value="csrf-page-token" />
    <input id="manual-checkin-input" role="combobox" type="text" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox"></div>
    <div class="hidden" id="manual-checkin-status"></div>
    <button id="manual-checkin-submit" type="submit"><span>Search</span></button>
  </form>
`;

/** The manual form's name box, checked to be the input the page renders. */
const nameBox = (h: ReturnType<ReturnType<typeof useScannerSuite>>) => {
  const input = el(h.document, "manual-checkin-input");
  if (!(input instanceof h.window.HTMLInputElement)) {
    throw new Error("The manual check-in name box is not an input");
  }
  return input;
};

/** Send the manual form and let the bundle's handler run to its end. */
const submitManual = async (
  h: ReturnType<ReturnType<typeof useScannerSuite>>,
): Promise<void> => {
  const form = el(h.document, "manual-checkin");
  form.dispatchEvent(
    new h.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  const button = el(h.document, "manual-checkin-submit");
  for (let hop = 0; hop < 200 && button.hasAttribute("disabled"); hop++) {
    await Promise.resolve();
  }
};

describe("scanner manual check-in while offline mode is on", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite(SCANNER_PAGE + MANUAL_FORM);

  test("finds a person in the saved list and queues the pick", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    const listKey = `scanner-tickets-${SCAN_PATH}`;
    h.window.localStorage.setItem(MODE_KEY, "1");
    h.window.localStorage.setItem(
      listKey,
      JSON.stringify({
        entries: [
          { ...savedEntry(await digestOf(TOKEN)), details: ["12 Jun"] },
          { ...savedEntry("other-digest"), name: "Ben" },
        ],
        storedAt: Date.now(),
      }),
    );

    nameBox(h).value = "ad";
    await submitManual(h);
    const options = [
      ...el(h.document, "ticket-options").querySelectorAll("[role=option]"),
    ];
    expect(options.map((option) => option.textContent)).toEqual([
      "Ada (1 ticket) — 12 Jun",
    ]);

    const first = options[0];
    if (!(first instanceof h.window.HTMLElement)) {
      throw new Error("The search shows no option");
    }
    first.click();
    await submitManual(h);

    const status = el(h.document, "manual-checkin-status");
    await whenStatusShows(
      status,
      "Ticket looks valid. It will be checked in when you are back online.",
    );
    await expectOneStoredCheckIn(h, TOKEN);
    // The search and the pick asked nothing of the network.
    expect(fetchStub.calls.length).toBe(0);
  });

  test("tells the door when the device holds no saved list", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    nameBox(h).value = "ad";
    await submitManual(h);

    expect(el(h.document, "manual-checkin-status").textContent).toBe(
      "No offline ticket list on this device. Go online and turn on offline mode first.",
    );
    expect(
      el(h.document, "ticket-options").querySelectorAll("[role=option]"),
    ).toHaveLength(0);
  });
});
