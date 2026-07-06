/**
 * Tests for the scroll-to-error enhancement
 * (`src/ui/client/admin/scroll-to-error.ts`), which anchors the page to the
 * first error alert after a form submit re-renders it — and only then.
 *
 * `errorAlertNeedsScroll` is a pure viewport check, tested table-driven. The
 * `initScrollToError` shell is browser code, so it runs against a happy-dom
 * `document`/`window`/`sessionStorage`, driving the real submit → reload flow.
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
    scrolls: ScrollIntoViewOptions[];
    /** Fire a `submit` event, as the browser does when a form is sent. */
    submit: () => void;
    /** The value stored under the submit-flag key, or null. */
    storedFlag: () => string | null;
    /** Overwrite the global `sessionStorage` (for the failure-mode tests). */
    breakStorage: () => void;
  };

  /** Install a happy-dom page from `html`, override the first `.error`'s rect
   * (happy-dom has no layout engine, so rects are otherwise all zero) and
   * capture any `scrollIntoView` call on it. */
  const setup = (
    html: string,
    rect?: { top: number; bottom: number },
  ): Harness => {
    const window = new Window({ url: "https://tickets.test/admin" });
    openWindow = window;
    window.document.body.innerHTML = html;
    const scrolls: ScrollIntoViewOptions[] = [];
    const first = window.document.querySelector(".error");
    if (first && rect) {
      (
        first as unknown as { getBoundingClientRect: () => DOMRect }
      ).getBoundingClientRect = () => rect as DOMRect;
      (
        first as unknown as {
          scrollIntoView: (o: ScrollIntoViewOptions) => void;
        }
      ).scrollIntoView = (options) => scrolls.push(options);
    }
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
      scrolls,
      storedFlag: () => window.sessionStorage.getItem("tickets:form-submitted"),
      // Submit events bubble to the document, where the listener lives.
      submit: () =>
        window.document.dispatchEvent(
          new window.Event("submit", { bubbles: true }),
        ),
    };
  };

  const errorHtml = `<div class="error" role="alert">A start date is required</div>`;

  test("does not scroll on a plain load with no preceding submit", () => {
    const h = setup(errorHtml, { bottom: 5040, top: 5000 });
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("a submit records the exact one-shot flag under the storage key", () => {
    const h = setup(errorHtml, { bottom: 5040, top: 5000 });
    initScrollToError(); // arms the submit listener
    h.submit();
    // Pin the exact key and value: the next load reads this precise pair.
    expect(h.storedFlag()).toBe("1");
  });

  test("scrolls to a below-the-fold error after a submit re-render", () => {
    const h = setup(errorHtml, { bottom: 5040, top: 5000 });
    initScrollToError(); // page A: arms the submit listener
    h.submit(); // the form is sent
    initScrollToError(); // page B: the re-render consumes the flag
    expect(h.scrolls).toEqual([{ block: "center" }]);
  });

  test("consumes the flag once — a later plain load does not re-scroll", () => {
    const h = setup(errorHtml, { bottom: 5040, top: 5000 });
    initScrollToError();
    h.submit();
    initScrollToError(); // consumes + scrolls
    h.scrolls.length = 0;
    initScrollToError(); // flag already cleared → nothing
    expect(h.scrolls).toEqual([]);
  });

  test("leaves an already-visible error where it is", () => {
    const h = setup(errorHtml, { bottom: 60, top: 10 });
    initScrollToError();
    h.submit();
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("does not chase an error when the submit succeeded (success flash)", () => {
    const h = setup(
      `<div class="success" role="alert">Saved</div>${errorHtml}`,
      { bottom: 5040, top: 5000 },
    );
    initScrollToError();
    h.submit();
    initScrollToError();
    expect(h.scrolls).toEqual([]);
  });

  test("does nothing after a submit when the page has no error alert", () => {
    const h = setup("<p>All good</p>");
    initScrollToError();
    h.submit();
    // No scrollIntoView is captured (no .error element exists at all).
    expect(() => initScrollToError()).not.toThrow();
  });

  test("survives a submit when sessionStorage is unavailable", () => {
    const h = setup(errorHtml, { bottom: 5040, top: 5000 });
    h.breakStorage();
    initScrollToError(); // consume swallows the throw → false
    expect(() => h.submit()).not.toThrow(); // remember swallows the throw
    expect(h.scrolls).toEqual([]);
  });
});
