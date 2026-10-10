/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The scanner bundle's confirm dialogs: the override a wrong-door ticket
 * asks for, the ID check a non-transferable listing asks for, and the
 * one-at-a-time rule that keeps a single click answering one prompt.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { showConfirm } from "#src/ui/client/confirm-dialog.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  el,
  forcedNoDoorScan,
  forcedVerifyScan,
  type ScannerHarness,
  useScannerSuite,
  whenMessageShows,
  whenTextShows,
} from "./fixture.ts";

/** A forced scan waiting at its override prompt: the helper serves the
 * given answers one per POST, starts the scan, and hands back the running
 * scan, the request bodies, and the fetch stub (dispose it with `using`). */
const forcedOverride = (
  h: ScannerHarness,
  answers: Record<string, unknown>[],
): {
  bodies: unknown[];
  done: Promise<void>;
  fetchStub: ReturnType<typeof stubFetch>;
} => {
  const bodies: unknown[] = [];
  const fetchStub = stubFetch((_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answers[bodies.length - 1] ?? { status: "error" });
  });
  const done = h.module.admitScan(
    "/admin/groups/5/scan",
    "tok",
    "csrf",
    h.statusEl,
    h.messages,
  );
  return { bodies, done, fetchStub };
};

/** The answers one forced scan replays up to the count ask: the wrong
 * listing, then the ask itself. */
const quantityAskAnswers: Record<string, unknown>[] = [
  { listingName: "Standard", name: "Ada", status: "wrong_listing" },
  { max: 3, name: "Ada", status: "select_quantity" },
];

describe("scanner confirmations", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("asks the organiser before an override, and takes their answer", async () => {
    const h = fresh();
    const overlay = h.confirm;

    const yes = h.module.showConfirm("Let this person in anyway?");
    await whenMessageShows(h, "Let this person in anyway?");
    overlay.yes.click();
    expect(await yes).toBe(true);

    const no = h.module.showConfirm("Check her ID?");
    await whenMessageShows(h, "Check her ID?");
    overlay.no.click();
    expect(await no).toBe(false);

    const dismissed = h.module.showConfirm("Check her ID?");
    await whenMessageShows(h, "Check her ID?");
    overlay.close.click();
    expect(await dismissed).toBe(false);
  });

  test("answers one confirmation at a time", async () => {
    const h = fresh();

    const first = h.module.showConfirm("Let this person in anyway?");
    const second = h.module.showConfirm("Check her ID?");

    // The camera loop and the manual form can both ask; only the question
    // the operator sees is open, and the second waits behind it.
    await whenMessageShows(h, "Let this person in anyway?");
    h.confirm.yes.click();
    expect(await first).toBe(true);

    // The click that answered the first prompt did not answer the hidden
    // second one: it shows in its turn, still unanswered.
    await whenMessageShows(h, "Check her ID?");
    h.confirm.no.click();
    expect(await second).toBe(false);
  });

  test("carries a forced scan through the ID prompt", async () => {
    const h = fresh();
    const { done, fetchStub } = await forcedVerifyScan(h);
    using _fetch = fetchStub;

    h.confirm.yes.click();
    await done;

    expect(h.statusEl.textContent).toBe(
      "Ada checked in for Standard (1 ticket)",
    );
    // The verified rescan carries both of the organiser's answers, so the
    // door-wide override survives the extra prompt.
    expect(
      fetchStub.calls.map((call) => JSON.parse(String(call.args[1]?.body))),
    ).toEqual([
      { token: "tok" },
      { force: true, token: "tok" },
      { force: true, id_verified: true, token: "tok" },
    ]);
  });

  test("a declined ID check after a force stops the admission", async () => {
    const h = fresh();
    const { done, fetchStub } = await forcedVerifyScan(h);
    using _fetch = fetchStub;

    h.confirm.no.click();
    await done;

    expect(h.statusEl.textContent).toBe("ID does not match Ada");
    expect(h.statusEl.className).toContain("scanner-status-error");
    // The refusal is the end: no verified rescan went out.
    expect(fetchStub.calls.length).toBe(2);
  });

  test("a forced scan that still finds no door says so, and asks nothing more", async () => {
    const h = fresh();
    const { done, fetchStub } = await forcedNoDoorScan(h);
    using _fetch = fetchStub;

    await whenTextShows(h.statusEl, "This ticket has no door to check in at.");
    expect(h.statusEl.className).toContain("scanner-status-error");
    await done;
    expect(fetchStub.calls.length).toBe(2);
  });

  test("declining the override skips the person with a warning", async () => {
    const h = fresh();
    const { bodies, done, fetchStub } = forcedOverride(h, [
      { listingName: "Standard", name: "Ada", status: "wrong_listing" },
    ]);
    using _fetch = fetchStub;

    await whenMessageShows(
      h,
      'Ada is registered for "Standard", not this listing. Check in anyway?',
    );
    h.confirm.no.click();
    await done;

    expect(bodies).toEqual([{ token: "tok" }]);
    expect(h.statusEl.textContent).toBe("Skipped Ada");
    expect(h.statusEl.className).toContain("scanner-status-warning");
  });

  test("declining the quantity ask skips the person with a warning", async () => {
    const h = fresh();
    const { bodies, done, fetchStub } = forcedOverride(h, [
      ...quantityAskAnswers,
    ]);
    using _fetch = fetchStub;

    await whenMessageShows(
      h,
      'Ada is registered for "Standard", not this listing. Check in anyway?',
    );
    h.confirm.yes.click();
    await whenTextShows(
      el(h.document, "scanner-quantity-message"),
      "How many tickets for Ada?",
    );
    el(h.document, "scanner-quantity-cancel").click();
    await done;

    expect(bodies).toEqual([{ token: "tok" }, { force: true, token: "tok" }]);
    expect(h.statusEl.textContent).toBe("Skipped Ada");
    expect(h.statusEl.className).toContain("scanner-status-warning");
  });

  test("keeps the override on every later ask, so a forced ticket can pick a count", async () => {
    const h = fresh();
    const { bodies, done, fetchStub } = forcedOverride(h, [
      ...quantityAskAnswers,
      {
        listingName: "Standard",
        name: "Ada",
        quantity: 2,
        status: "checked_in",
        total: 2,
      },
    ]);
    using _fetch = fetchStub;

    await whenMessageShows(
      h,
      'Ada is registered for "Standard", not this listing. Check in anyway?',
    );
    h.confirm.yes.click();
    const quantity = el(h.document, "scanner-quantity");
    for (
      let hops = 0;
      hops < 100 && quantity.classList.contains("hidden");
      hops++
    ) {
      await Promise.resolve();
    }
    expect(quantity.classList.contains("hidden")).toBe(false);
    (
      el(h.document, "scanner-quantity-select") as unknown as HTMLSelectElement
    ).value = "2";
    el(h.document, "scanner-quantity-confirm").click();
    await done;

    expect(bodies).toEqual([
      { token: "tok" },
      { force: true, token: "tok" },
      { force: true, quantity: 2, token: "tok" },
    ]);
    expect(h.statusEl.textContent).toBe(
      "Ada checked in for Standard (2 tickets)",
    );
  });

  test("the camera and the manual form share one question queue", async () => {
    // The camera loop ships in the scanner bundle and the manual form in the
    // admin bundle, so each carries its own copy of the dialog code. A click
    // must still answer only the question the operator sees.
    const h = fresh();

    const camera = h.module.showConfirm("Let this person in anyway?");
    const manual = showConfirm("Check her ID?");

    await whenMessageShows(h, "Let this person in anyway?");
    h.confirm.yes.click();
    expect(await camera).toBe(true);

    await whenMessageShows(h, "Check her ID?");
    h.confirm.no.click();
    expect(await manual).toBe(false);
  });
});
