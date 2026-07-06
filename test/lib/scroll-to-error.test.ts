/**
 * Tests for the scroll-to-error enhancement
 * (`src/ui/client/admin/scroll-to-error.ts`), which anchors the page to a
 * freshly-raised validation error after a form submit re-renders it.
 *
 * `errorAlertNeedsScroll` is a pure viewport check, tested table-driven. The
 * `initScrollToError` shell is browser code, so it runs against a happy-dom
 * `document`/`window`/`sessionStorage`, driving the real load → submit → reload
 * flow. A plain load records the page's standing notes as a baseline; a submit
 * re-render scrolls to the first alert not in that baseline.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { Window } from "happy-dom";
import {
  errorAlertNeedsScroll,
  initScrollToError,
} from "#src/ui/client/admin/scroll-to-error.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

describe("errorAlertNeedsScroll", () => {
  const viewport = 800;
  // [name, top, bottom, needsScroll] — the edge cases (flush against either
  // border) pin the boundary so `<`/`>` can't drift to `<=`/`>=`, and the
  // off-screen cases pin the `||` so it can't drift to `&&`.
  const cases: [string, number, number, boolean][] = [
    ["comfortably inside the viewport", 100, 200, false],
    ["flush against the top edge", 0, 60, false],
    ["flush against the bottom edge", 740, 800, false],
    ["clipped off the top", -1, 40, true],
    ["clipped off the bottom", 780, 801, true],
    ["taller than the viewport", -5, 900, true],
  ];
  for (const [name, top, bottom, expected] of cases) {
    test(`${name} -> needsScroll=${expected}`, () => {
      expect(errorAlertNeedsScroll(top, bottom, viewport)).toBe(expected);
    });
  }
});

// happy-dom's `Window` starts internal async tasks/timers (its task manager)
// that no public teardown — `abort()`, `close()` — fully clears, so Deno's
// op/resource sanitizers flag them as leaks under the runner. They are confined
// to the emulated DOM and torn down in `afterEach`; disable the sanitizers for
// this suite only, as the order-widget suite does.
describe("initScrollToError", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const stash = createGlobalStash();
  let openWindow: Window | null = null;
  afterEach(async () => {
    if (openWindow) {
      await openWindow.happyDOM.abort();
      openWindow.close();
      openWindow = null;
    }
    stash.restore();
  });

  type Harness = {
    /** The text of each element `scrollIntoView` was called on, in order. */
    scrolled: () => string[];
    /** The options of the last `scrollIntoView` call. */
    lastOptions: () => ScrollIntoViewOptions | undefined;
    /** Fire a `submit` event from a form with the given method (default POST);
     * pass `cancelled` to model a form that called `preventDefault` (posts via
     * fetch, no re-render). */
    submit: (opts?: { cancelled?: boolean; method?: string }) => void;
    /** Fire a `pageshow` event (bfcache restore when `persisted` is true). */
    pageshow: (persisted: boolean) => void;
    /** The raw value stored under the baseline key, or null. */
    baseline: () => string | null;
    /** Replace the page markup, as a navigation / re-render would. */
    render: (html: string) => void;
    /** Directly poke the baseline store (for the corrupted-value test). */
    setBaseline: (value: string) => void;
    /** Remove the stored baseline (e.g. storage evicted it between loads). */
    clearBaseline: () => void;
    /** Overwrite the global `sessionStorage` (for the failure-mode tests). */
    breakStorage: () => void;
  };

  /** Install a happy-dom page and instrument every error alert: happy-dom has
   * no layout engine, so each gets a scripted rect (keyed by `data-rect`:
   * "on" = on-screen, otherwise far below the fold) and a captured
   * `scrollIntoView`. */
  const setup = (html: string): Harness => {
    const window = new Window({ url: "https://tickets.test/admin" });
    openWindow = window;
    const scrolls: { text: string; options: ScrollIntoViewOptions }[] = [];
    const instrument = (): void => {
      for (const el of window.document.querySelectorAll(
        '.error[role="alert"]',
      )) {
        const rect =
          el.getAttribute("data-rect") === "on"
            ? { bottom: 60, top: 10 }
            : { bottom: 5040, top: 5000 };
        (
          el as unknown as { getBoundingClientRect: () => DOMRect }
        ).getBoundingClientRect = () => rect as DOMRect;
        (
          el as unknown as {
            scrollIntoView: (o: ScrollIntoViewOptions) => void;
          }
        ).scrollIntoView = (options) =>
          scrolls.push({ options, text: (el.textContent ?? "").trim() });
      }
    };
    const render = (markup: string): void => {
      window.document.body.innerHTML = markup;
      instrument();
    };
    render(html);
    stash.set("document", window.document);
    stash.set("window", window);
    stash.set("sessionStorage", window.sessionStorage);
    return {
      baseline: () => window.sessionStorage.getItem("tickets:error-baseline"),
      breakStorage: () => {
        const boom = (): never => {
          throw new Error("storage disabled");
        };
        stash.set("sessionStorage", {
          getItem: boom,
          removeItem: boom,
          setItem: boom,
        });
      },
      clearBaseline: () =>
        window.sessionStorage.removeItem("tickets:error-baseline"),
      lastOptions: () => scrolls.at(-1)?.options,
      pageshow: (persisted) => {
        const event = new window.Event("pageshow");
        Object.defineProperty(event, "persisted", { value: persisted });
        window.dispatchEvent(event);
      },
      render,
      scrolled: () => scrolls.map((s) => s.text),
      setBaseline: (value) =>
        window.sessionStorage.setItem("tickets:error-baseline", value),
      submit: ({ cancelled = false, method = "post" } = {}) => {
        // Submit events fire on a form; give it the right method so the POST-only
        // guard sees it, and attach it so the event bubbles to the document.
        const form = window.document.createElement("form");
        form.setAttribute("method", method);
        window.document.body.appendChild(form);
        const event = new window.Event("submit", {
          bubbles: true,
          cancelable: true,
        });
        if (cancelled) event.preventDefault();
        form.dispatchEvent(event);
      },
    };
  };

  // A standing note (on-screen, always present) and, further down the form, the
  // validation errors a submit can raise (off-screen). Mirrors the attendee
  // form, where the balance-ledger note renders above the date/quantity fields.
  const note = `<div class="error" role="alert" data-rect="on">Standing ledger note</div>`;
  const dateError = `<div class="error" role="alert">A start date is required</div>`;
  const qtyError = `<div class="error" role="alert">Too many tickets</div>`;
  const successFlash = `<div class="success" role="alert">Saved</div>`;

  test("does not scroll on a plain load with no preceding submit", () => {
    const h = setup(dateError); // off-screen error, but no submit happened
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("scrolls to the fresh error, skipping the standing note", () => {
    const h = setup(note); // plain load: baseline = {standing note}
    initScrollToError();
    h.submit();
    h.render(note + dateError); // server re-renders with the new error
    initScrollToError();
    expect(h.scrolled()).toEqual(["A start date is required"]);
    expect(h.lastOptions()).toEqual({ block: "center" });
  });

  test("scrolls to an error that persists across a retry", () => {
    const h = setup(note); // plain load: baseline = {standing note}
    initScrollToError();
    h.submit(); // first submit
    h.render(note + dateError + qtyError); // two independent errors
    initScrollToError(); // scrolls to the first (date)
    h.submit(); // operator fixed the date, resubmits
    h.render(note + qtyError); // date gone, quantity error remains
    initScrollToError();
    // The quantity error was already visible on the previous render, but it is
    // NOT a standing note, so the retry still scrolls to it.
    expect(h.scrolled()).toEqual([
      "A start date is required",
      "Too many tickets",
    ]);
  });

  test("does not scroll when a success flash is present (redirect target)", () => {
    // Baseline was captured on some other page (empty), then the successful
    // submit redirected here — a page that carries its own standing note.
    const h = setup(note); // plain load elsewhere would set a baseline; here none matches
    initScrollToError();
    h.submit();
    h.render(successFlash + note); // redirect target: success + a standing note
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("does not scroll when the fresh error is already visible", () => {
    const h = setup(note);
    initScrollToError();
    h.submit();
    h.render(
      `${note}<div class="error" role="alert" data-rect="on">Name is required</div>`,
    );
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("does not scroll when the submit raised no new error", () => {
    const h = setup(note);
    initScrollToError();
    h.submit();
    h.render(note); // re-render still shows only the standing note
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("consumes the submit marker once — a later plain load does not scroll", () => {
    const h = setup(note);
    initScrollToError();
    h.submit();
    h.render(note + dateError);
    initScrollToError(); // submit re-render: scrolls
    initScrollToError(); // now a plain load (marker cleared): re-baselines, no scroll
    expect(h.scrolled()).toEqual(["A start date is required"]);
  });

  test("ignores a client-cancelled submit (no re-render is coming)", () => {
    const h = setup(note);
    initScrollToError();
    h.submit({ cancelled: true }); // preventDefault()'d — e.g. a fetch-posting form
    h.render(note + dateError);
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("ignores a GET form submit (a filter / navigation, not a re-render)", () => {
    const h = setup(note);
    initScrollToError();
    h.submit({ method: "get" }); // e.g. the availability-checker's GET form
    h.render(note + dateError);
    initScrollToError();
    expect(h.scrolled()).toEqual([]);
  });

  test("re-records the baseline on a bfcache restore (persisted pageshow)", () => {
    const h = setup(note); // attendee page: standing note
    initScrollToError(); // baseline = {standing note}
    h.setBaseline(JSON.stringify(["A note from some other page"])); // a page visited in between
    h.pageshow(true); // press Back → bfcache restore re-baselines to this page
    h.submit();
    h.render(note + dateError);
    initScrollToError();
    expect(h.scrolled()).toEqual(["A start date is required"]);
  });

  test("a non-persisted pageshow leaves the baseline alone", () => {
    const h = setup(note);
    initScrollToError();
    h.setBaseline(JSON.stringify(["Elsewhere"]));
    h.pageshow(false); // an ordinary navigation pageshow — not a bfcache restore
    expect(h.baseline()).toBe(JSON.stringify(["Elsewhere"]));
  });

  test("scrolls to the error when no baseline was ever recorded", () => {
    const h = setup(dateError);
    initScrollToError(); // arms the listener, baseline = {date error}
    h.clearBaseline(); // storage evicted the baseline between loads
    h.submit();
    initScrollToError(); // missing baseline → empty → error is "fresh"
    expect(h.scrolled()).toEqual(["A start date is required"]);
  });

  test("treats a corrupted baseline as empty, still scrolling to the error", () => {
    const h = setup(dateError);
    initScrollToError(); // arms the listener, baseline = {date error}
    h.setBaseline("not json"); // e.g. tampered storage
    h.submit();
    initScrollToError(); // corrupted baseline parses to empty → error is "fresh"
    expect(h.scrolled()).toEqual(["A start date is required"]);
  });

  test("records the submit marker so the next load knows a submit happened", () => {
    const h = setup(note);
    initScrollToError(); // arms the listener
    h.submit();
    // The exact key/value the next load reads to decide it followed a submit.
    expect(openWindow!.sessionStorage.getItem("tickets:form-submitted")).toBe(
      "1",
    );
  });

  test("records the standing notes under the baseline key on a plain load", () => {
    setup(note);
    initScrollToError();
    // The exact key and payload a later submit re-render reads back.
    const stored = openWindow!.sessionStorage.getItem("tickets:error-baseline");
    expect(stored).toBe(JSON.stringify(["Standing ledger note"]));
  });

  test("survives a submit when sessionStorage is unavailable", () => {
    const h = setup(dateError); // off-screen: a stray scroll would register
    h.breakStorage();
    initScrollToError(); // reads throw → treated as no submit, writes swallowed
    expect(() => h.submit()).not.toThrow();
    expect(h.scrolled()).toEqual([]);
  });
});
