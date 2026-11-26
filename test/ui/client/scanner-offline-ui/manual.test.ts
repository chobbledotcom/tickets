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
  cameraFakes,
  savedEntry,
  seedTicketCache,
  start,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  MODE_KEY,
  SCAN_PATH,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  digestOf,
  expectOneStoredCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

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
  const fresh = useScannerSuite();

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

  test("queues a ticket once when a scan and a pick wait on the same ask", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });

    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    // The fakes own the clock, so the seed lands after they do.
    h.window.localStorage.setItem(MODE_KEY, "1");
    await seedTicketCache(h, TOKEN, Date.now(), 3);
    // The camera's scan of the party of three opens the quantity ask.
    fakes.decode({ data: TOKEN });
    fakes.advance(1000);
    const ask = el(h.document, "scanner-quantity");
    const askMessage = el(h.document, "scanner-quantity-message");
    await whenStatusShows(askMessage, "How many people are you checking in?");

    // While that ask waits, the door picks the same person by name. The
    // pick's early check sees an empty queue, so its own ask queues behind
    // the camera's.
    nameBox(h).value = "ad";
    await submitManual(h);
    const first = el(h.document, "ticket-options").querySelector(
      "[role=option]",
    );
    if (!(first instanceof h.window.HTMLElement)) {
      throw new Error("The search shows no option");
    }
    first.click();
    await submitManual(h);

    // Answering the camera's ask queues the scan...
    el(h.document, "scanner-quantity-confirm").click();
    await whenStatusShows(
      h.statusEl,
      "Ticket looks valid. It will be checked in when you are back online.",
    );

    // ...and the pick's ask opens behind it. Answering it must not queue a
    // second check-in for the same ticket.
    for (let hops = 0; hops < 200 && ask.classList.contains("hidden"); hops++) {
      await Promise.resolve();
    }
    expect(ask.classList.contains("hidden")).toBe(false);
    el(h.document, "scanner-quantity-confirm").click();
    await whenStatusShows(
      el(h.document, "manual-checkin-status"),
      "This ticket is already queued. Do not let them in again.",
    );

    expect(JSON.parse(String(storedQueue(h)))).toEqual([
      {
        operationId: expect.any(String),
        quantity: 3,
        queuedAt: expect.any(Number),
        scanPath: SCAN_PATH,
        tokenHash: await digestOf(TOKEN),
      },
    ]);
  });
});
