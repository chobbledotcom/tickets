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
import {
  forcedVerifyScan,
  useScannerSuite,
  whenMessageShows,
} from "./fixture.ts";

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
});
