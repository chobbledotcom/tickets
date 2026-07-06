/**
 * Tests for the scroll-to-error enhancement
 * (`src/ui/client/admin/scroll-to-error.ts`), which anchors the page to the
 * first *newly-raised* error alert after a form submit re-renders it.
 *
 * `errorAlertNeedsScroll` is a pure viewport check, tested table-driven. The
 * `initScrollToError` shell is browser code, so it runs against a happy-dom
 * `document`/`window`/`sessionStorage`, driving the real submit → reload flow:
 * a snapshot of the errors already on the page is taken on submit, and the next
 * load scrolls to the first error that was NOT in that snapshot.
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
    /** The element each `scrollIntoView` was called on, with its options. */
    scrolls: { text: string; options: ScrollIntoViewOptions }[];
    /** Fire a `submit` event; pass `cancelled` to model a form that called
     * `preventDefault` (posts via fetch, no re-render). */
    submit: (cancelled?: boolean) => void;
    /** Replace `.error[role="alert"]` markup, as a re-render would. */
    render: (html: string) => void;
    /** The raw value stored under the snapshot key, or null. */
    snapshot: () => string | null;
    /** Overwrite the global `sessionStorage` (for the failure-mode tests). */
    breakStorage: () => void;
  };

  /** Install a happy-dom page and instrument every error alert: happy-dom has
   * no layout engine, so each gets a scripted rect (keyed by the `data-rect`
   * attribute: "on" = on-screen, otherwise far below the fold) and a captured
   * `scrollIntoView`. */
  const setup = (html: string): Harness => {
    const window = new Window({ url: "https://tickets.test/admin" });
    openWindow = window;
    const scrolls: { text: string; options: ScrollIntoViewOptions }[] = [];
    const instrument = (): void => {
      for (const el of window.document.querySelectorAll(
        '.error[role="alert"]',
      )) {
        const onScreen = el.getAttribute("data-rect") === "on";
        const rect = onScreen
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
      breakStorage: () => {
        const boom = (): never => {
          throw new Error("storage disabled");
        };
        stash.set("sessionStorage", { getItem: boom, setItem: boom });
      },
      render,
      scrolls,
      snapshot: () => window.sessionStorage.getItem("tickets:submit-errors"),
      submit: (cancelled = false) => {
        const event = new window.Event("submit", {
          bubbles: true,
          cancelable: true,
        });
        if (cancelled) event.preventDefault();
        window.document.dispatchEvent(event);
      },
    };
  };

  // A standing note (on-screen, always present) followed by a to-be-raised
  // validation error further down the form (off-screen). Mirrors the attendee
  // form, where the balance-ledger note is rendered before the date field.
  const standingNote = `<div class="error" role="alert" data-rect="on">Standing ledger note</div>`;
  const dateError = `<div class="error" role="alert">A start date is required</div>`;

  test("does not scroll on a plain load with no preceding submit", () => {
    // The error is off-screen, so any scroll would register — proving the
    // no-submit path really returns early rather than just finding nothing.
    const h = setup(dateError);
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("records the pre-submit errors under the snapshot key", () => {
    const h = setup(standingNote);
    initScrollToError(); // arms the listener
    h.submit();
    // The exact key and payload the next load reads back: the errors already
    // showing when the form was sent.
    expect(h.snapshot()).toBe(JSON.stringify(["Standing ledger note"]));
  });

  test("scrolls to the freshly-raised error, skipping the standing note", () => {
    const h = setup(standingNote); // page as first loaded: only the standing note
    initScrollToError(); // arms the listener
    h.submit(); // form sent — snapshots {standing note}
    h.render(standingNote + dateError); // server re-renders with the new error
    initScrollToError(); // page B: consumes the snapshot
    // The standing note was already there; only the date error is new.
    expect(h.scrolls.map((s) => s.text)).toEqual(["A start date is required"]);
    expect(h.scrolls[0]?.options).toEqual({ block: "center" });
  });

  test("does not scroll when the freshly-raised error is already visible", () => {
    const h = setup(standingNote);
    initScrollToError();
    h.submit();
    // The new error is on-screen (data-rect="on"): no nudge needed.
    h.render(
      `${standingNote}<div class="error" role="alert" data-rect="on">Name is required</div>`,
    );
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("does not scroll when the submit raised no new error (it succeeded)", () => {
    const h = setup(standingNote);
    initScrollToError();
    h.submit();
    h.render(standingNote); // re-render still shows only the standing note
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("consumes the snapshot once — a later plain load does not re-scroll", () => {
    const h = setup(standingNote);
    initScrollToError();
    h.submit();
    h.render(standingNote + dateError);
    initScrollToError(); // consumes + scrolls
    h.scrolls.length = 0;
    initScrollToError(); // snapshot already cleared → nothing
    expect(h.scrolls).toEqual([]);
  });

  test("ignores a client-cancelled submit (no re-render is coming)", () => {
    const h = setup(standingNote);
    initScrollToError();
    h.submit(true); // preventDefault()'d — e.g. a fetch-posting form
    h.render(standingNote + dateError);
    initScrollToError();
    // No snapshot was stored, so the later error is not chased.
    expect(h.scrolls).toEqual([]);
  });

  test("survives a submit when sessionStorage is unavailable", () => {
    // The error is off-screen, so the early return (not a missed scroll) is
    // what keeps the page still when storage throws.
    const h = setup(dateError);
    h.breakStorage();
    initScrollToError(); // takeSnapshot swallows the throw → null
    expect(() => h.submit()).not.toThrow(); // remember swallows the throw
    expect(h.scrolls).toEqual([]);
  });
});
