/**
 * Behavioural tests for the order gallery's live-availability enhancement
 * (`src/ui/client/admin/order-gallery.ts`). The script is browser code — it
 * reads `document`, `FormData`, and `fetch` from the global scope — so each
 * test installs a fresh happy-dom `Window` plus a scripted `fetch` stub, runs
 * `initOrderGallery()`, and drives real `change` events through the form.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { Window } from "happy-dom";
import { initOrderGallery } from "#src/ui/client/admin/order-gallery.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

type CardState = { state: string; label: string };
type AvailabilityBody = {
  dateNeeded?: boolean;
  states?: Record<string, CardState>;
};

const GALLERY_HTML = `
  <form data-order-gallery>
    <div class="order-date" data-order-date>
      <input name="start_date" type="date" />
    </div>
    <input name="order" type="hidden" value="" />
    <label data-order-key="package:7">
      <input class="order-select" name="select_package_7" type="checkbox" value="1" />
      <span data-order-state-label></span>
    </label>
    <label data-order-key="listing:5">
      <input class="order-select" name="select_5" type="checkbox" value="1" />
      <span data-order-state-label></span>
    </label>
    <input name="loose" type="checkbox" value="1" />
    <select name="pick"><option value="x" selected>x</option></select>
    <input name="upload" type="file" />
  </form>`;

const stash = createGlobalStash();

// The availability refresh debounces on a real 200ms setTimeout; run every
// test on a virtual clock so settle() skips past it instantly instead of each
// test genuinely sleeping 300ms.
const clock: { time: FakeTime | null } = { time: null };

const getClock = (): FakeTime => {
  if (clock.time === null) throw new Error("Fake clock was not installed");
  return clock.time;
};

/** Install the DOM and a scripted availability endpoint, then boot the
 * script. `responses` are consumed one per request; when empty the endpoint
 * answers "everything fine, no states". */
const harness = (html = GALLERY_HTML) => {
  const window = new Window({ url: "https://tickets.test/order" });
  window.document.body.innerHTML = html;
  const requests: string[] = [];
  const responses: Array<{ ok: boolean; body: AvailabilityBody }> = [];
  stash.set("document", window.document);
  stash.set("FormData", window.FormData);
  stash.set("HTMLInputElement", window.HTMLInputElement);
  stash.set("fetch", (input: unknown): Promise<unknown> => {
    requests.push(String(input));
    const next = responses.shift() ?? { body: { states: {} }, ok: true };
    return Promise.resolve({
      json: () => Promise.resolve(next.body),
      ok: next.ok,
    });
  });
  initOrderGallery();
  const document = window.document;
  return {
    boxFor: (name: string) =>
      document.querySelector(`input[name="${name}"]`) as unknown as {
        checked: boolean;
        disabled: boolean;
        dispatchEvent: (event: unknown) => void;
      },
    cardFor: (key: string) =>
      document.querySelector(`[data-order-key="${key}"]`) as unknown as {
        dataset: Record<string, string | undefined>;
        querySelector: (sel: string) => { textContent: string } | null;
      },
    changeField: (selector: string) => {
      const field = document.querySelector(selector) as unknown as {
        dispatchEvent: (event: unknown) => void;
      };
      field.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    dateWrap: document.querySelector("[data-order-date]") as unknown as {
      classList: { contains: (cls: string) => boolean };
    },
    orderField: document.querySelector('input[name="order"]') as unknown as {
      value: string;
    },
    requests,
    responses,
    tick: (name: string, checked: boolean) => {
      const box = document.querySelector(
        `input[name="${name}"]`,
      ) as unknown as {
        checked: boolean;
        dispatchEvent: (event: unknown) => void;
      };
      box.checked = checked;
      box.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
  };
};

/** Advance the virtual clock past the 200ms refresh debounce, then drain the
 *  response microtasks (tickAsync flushes them BEFORE advancing, so the
 *  fired callback's await chain needs one more round). */
const settle = async (): Promise<void> => {
  await getClock().tickAsync(300);
  await getClock().runMicrotasks();
};

describe("initOrderGallery", () => {
  beforeEach(() => {
    clock.time = new FakeTime();
  });
  afterEach(() => {
    // beforeEach always installs the clock; teardown must fail if that changes.
    getClock().restore();
    clock.time = null;
    stash.restore();
  });

  test("does nothing on a page without the gallery form", () => {
    const window = new Window({ url: "https://tickets.test/" });
    window.document.body.innerHTML = "<p>No gallery here</p>";
    stash.set("document", window.document);
    expect(() => initOrderGallery()).not.toThrow();
  });

  test("records the order cards were ticked in, add and remove", async () => {
    const page = harness();
    page.tick("select_package_7", true);
    page.tick("select_5", true);
    expect(page.orderField.value).toBe("package:7,listing:5");

    page.tick("select_package_7", false);
    expect(page.orderField.value).toBe("listing:5");

    page.tick("select_package_7", true);
    expect(page.orderField.value).toBe("listing:5,package:7");
    // Drain this page's debounce so its refresh never fires into a later test.
    await settle();
  });

  test("records a selected card only once", async () => {
    const page = harness();
    page.tick("select_package_7", true);
    page.tick("select_package_7", true);
    expect(page.orderField.value).toBe("package:7");
    await settle();
  });

  test("does not record a card that was unticked before it was selected", async () => {
    const page = harness();
    page.tick("select_package_7", false);
    expect(page.orderField.value).toBe("");
    await settle();
  });

  test("removes the second selected card from the recorded order", async () => {
    const page = harness();
    page.tick("select_package_7", true);
    page.tick("select_5", true);
    page.tick("select_5", false);
    expect(page.orderField.value).toBe("package:7");
    await settle();
  });

  test("a change outside any card leaves the recorded order alone", async () => {
    const page = harness();
    page.tick("select_5", true);
    page.tick("loose", true);
    // Non-checkbox changes (the date field, a select) refresh availability
    // but never touch the recorded order either.
    page.changeField('input[name="start_date"]');
    page.changeField('select[name="pick"]');
    expect(page.orderField.value).toBe("listing:5");
    await settle();
  });

  test("collapses rapid changes into one availability request", async () => {
    const page = harness();
    page.tick("select_package_7", true);
    page.tick("select_5", true);
    await settle();
    expect(page.requests).toHaveLength(1);
    // The single settled request carries the full selection, the (blank)
    // date, and the order things were added in.
    expect(page.requests[0]).toContain("/order/availability?");
    expect(page.requests[0]).toContain("select_package_7=1");
    expect(page.requests[0]).toContain("select_5=1");
    expect(page.requests[0]).toContain("order=package%3A7%2Clisting%3A5");
    // File entries never join the query — only string form fields do.
    expect(page.requests[0]).not.toContain("upload");
  });

  test("waits for the debounce delay before checking availability", async () => {
    const page = harness();
    page.tick("select_package_7", true);
    await clock.time!.tickAsync(199);
    expect(page.requests).toHaveLength(0);

    await clock.time!.tickAsync(1);
    await clock.time!.runMicrotasks();
    expect(page.requests).toHaveLength(1);
  });

  test("applies returned states: labels, greying, and the date nudge", async () => {
    const page = harness();
    page.responses.push({
      body: {
        dateNeeded: true,
        states: {
          "listing:5": {
            label: "Remove Party Bundle to add",
            state: "blocked",
          },
          "package:7": { label: "", state: "selected" },
        },
      },
      ok: true,
    });
    const label = page
      .cardFor("listing:5")
      .querySelector("[data-order-state-label]");
    if (label) label.textContent = "Checking availability";
    page.tick("select_package_7", true);
    await settle();

    const card = page.cardFor("listing:5");
    expect(card.dataset.orderState).toBe("blocked");
    expect(card.querySelector("[data-order-state-label]")?.textContent).toBe(
      "Remove Party Bundle to add",
    );
    // The unfitting card can't be ticked; the ticked card is never locked.
    expect(page.boxFor("select_5").disabled).toBe(true);
    expect(page.boxFor("select_package_7").disabled).toBe(false);
    expect(page.dateWrap.classList.contains("order-date--needed")).toBe(true);

    // The contested capacity frees up: the card un-greys and the nudge clears.
    page.responses.push({
      body: {
        dateNeeded: false,
        states: {
          "listing:5": { label: "", state: "available" },
          "package:7": { label: "", state: "available" },
        },
      },
      ok: true,
    });
    page.tick("select_package_7", false);
    await settle();
    expect(page.cardFor("listing:5").dataset.orderState).toBe("available");
    expect(page.boxFor("select_5").disabled).toBe(false);
    expect(page.dateWrap.classList.contains("order-date--needed")).toBe(false);
  });

  test("a ticked card is never disabled even when its state no longer fits", async () => {
    const page = harness();
    page.responses.push({
      body: {
        states: { "listing:5": { label: "Sold Out", state: "unavailable" } },
      },
      ok: true,
    });
    page.tick("select_5", true);
    await settle();
    expect(page.boxFor("select_5").disabled).toBe(false);
    expect(page.cardFor("listing:5").dataset.orderState).toBe("unavailable");
  });

  test("disables an unticked card when it is unavailable", async () => {
    const page = harness();
    page.responses.push({
      body: {
        states: { "listing:5": { label: "Sold out", state: "unavailable" } },
      },
      ok: true,
    });
    page.changeField('input[name="start_date"]');
    await settle();
    expect(page.boxFor("select_5").disabled).toBe(true);
  });

  test("ignores non-OK responses and cards the payload does not name", async () => {
    const page = harness();
    page.responses.push({ body: {}, ok: false });
    page.tick("select_5", true);
    await settle();
    expect(page.requests).toHaveLength(1);
    expect(page.cardFor("listing:5").dataset.orderState).toBeUndefined();

    // A payload naming only one card leaves the other untouched.
    page.responses.push({
      body: { states: { "package:7": { label: "", state: "available" } } },
      ok: true,
    });
    page.tick("select_5", false);
    await settle();
    expect(page.cardFor("package:7").dataset.orderState).toBe("available");
    expect(page.cardFor("listing:5").dataset.orderState).toBeUndefined();
  });

  test("treats a payload without states as no news at all", async () => {
    const page = harness();
    page.responses.push({ body: { dateNeeded: false }, ok: true });
    page.tick("select_5", true);
    await settle();
    expect(page.cardFor("listing:5").dataset.orderState).toBeUndefined();
    expect(page.dateWrap.classList.contains("order-date--needed")).toBe(false);
  });

  test("survives a fetch rejection (offline) without applying anything", async () => {
    const page = harness();
    stash.set("fetch", () => Promise.reject(new Error("offline")));
    page.tick("select_5", true);
    await settle();
    expect(page.cardFor("listing:5").dataset.orderState).toBeUndefined();
  });
});
