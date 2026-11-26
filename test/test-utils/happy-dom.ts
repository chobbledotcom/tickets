/**
 * Global-scope stash for happy-dom based tests.
 *
 * Browser modules read `document`/`window`/etc. from the global scope, so
 * tests that exercise them under Deno install a happy-dom `Window`'s pieces
 * onto `globalThis` for the duration of the test. The stash records each
 * overwritten property's original descriptor so `restore()` puts the real
 * global scope back exactly as it was — including properties that did not
 * exist before (deleted on restore).
 */

import { Window } from "happy-dom";
import { requireValue } from "#shared/required-value.ts";

export interface GlobalStash {
  restore: () => void;
  set: (key: string, value: unknown) => void;
}

/** Create a stash that can overwrite globals and restore them afterwards. */
export const createGlobalStash = (): GlobalStash => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  return {
    restore: (): void => {
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      saved.clear();
    },
    set: (key: string, value: unknown): void => {
      if (!saved.has(key)) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      }
      const globals = globalThis as Record<string, unknown>;
      // Delete-then-assign, not defineProperty: an existing global may be a
      // getter-only accessor (navigator, sessionStorage) that plain
      // assignment can't pass, while Deno's global-scope resolution for npm
      // modules only honours plain data properties — a defineProperty'd
      // `window` stays a ReferenceError inside an npm package.
      delete globals[key];
      globals[key] = value;
    },
  };
};

/** A reusable "fresh happy-dom window per test" harness. */
export type DomInstaller = {
  /** Mount a fresh window (with the given body) onto the globals. */
  installDom: (bodyHtml: string) => Window;
  /** Restore the globals and close every opened window (call in afterEach). */
  cleanup: () => Promise<void>;
};

/**
 * Create a happy-dom installer that sets `document`/`window` (plus any named
 * extra window globals — functions are bound to their window, so
 * `getComputedStyle` keeps working) and cleans everything up afterwards.
 */
export const createDomInstaller = (
  extraGlobals: string[] = [],
): DomInstaller => {
  const stash = createGlobalStash();
  const openWindows: Window[] = [];
  return {
    cleanup: async (): Promise<void> => {
      stash.restore();
      // happyDOM.close() (not the DOM-level window.close()) aborts pending
      // async tasks, so nothing a test started can fail after it finished.
      await Promise.all(openWindows.map((window) => window.happyDOM.close()));
      openWindows.length = 0;
    },
    installDom: (bodyHtml: string): Window => {
      const window = new Window({
        // Tests exercise DOM wiring only — never let an injected <script src>,
        // <link> stylesheet, or <iframe src> start a real fetch of its URL.
        settings: {
          disableCSSFileLoading: true,
          // Deprecated in happy-dom but still the gate that keeps any iframe
          // in the window from opening a child page (and its navigation
          // timer).
          disableIframePageLoading: true,
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
        },
        url: "https://admin.test/",
      });
      window.document.body.innerHTML = bodyHtml;
      stash.set("document", window.document);
      stash.set("window", window);
      for (const key of extraGlobals) {
        const value = (window as unknown as Record<string, unknown>)[key];
        // getComputedStyle is a plain method that needs its window as `this`;
        // classes (Event, MutationObserver, …) are installed as-is so their
        // prototypes stay reachable.
        stash.set(
          key,
          key === "getComputedStyle" && typeof value === "function"
            ? value.bind(window)
            : value,
        );
      }
      openWindows.push(window);
      return window;
    },
  };
};

/**
 * The one element the selector must name, as the given element type. Throws
 * naming the selector when the page lacks it, so a wrong selector fails here
 * instead of a `null` flowing on as a confusing `TypeError` later. The root
 * is structural so both a real document and a scoped element work.
 */
export const requireElement = <T extends Element>(
  root: { querySelector(selector: string): Element | null },
  selector: string,
): T => {
  const el = root.querySelector(selector) as T | null;
  if (!el) throw new Error(`The page carries no ${selector}`);
  return el;
};

/**
 * Every element the selector names, as the given element type. happy-dom ties
 * its query types to tag names, so a class selector cannot ask for a typed
 * list directly. The root is structural, as in {@link requireElement}.
 */
export const requireElements = <T extends Element>(
  root: { querySelectorAll(selector: string): ArrayLike<Element> },
  selector: string,
): T[] => Array.from(root.querySelectorAll(selector)) as T[];

/** Close every dialog the selector names, so one test leaves no window open
 *  for the next. */
export const closeDialogs = (root: ParentNode, selector: string): void => {
  for (const dialog of root.querySelectorAll<HTMLDialogElement>(selector)) {
    dialog.close();
  }
};

/**
 * Fire a happy-dom event at an element. Client code is compiled against the
 * DOM lib's `Event`, happy-dom declares its own — the two describe the same
 * runtime shape, so the element's own `dispatchEvent` takes the event as is.
 * One name here instead of a cast at every dispatch.
 */
export const fireEvent = (
  target: { dispatchEvent(event: unknown): unknown },
  event: unknown,
): void => {
  target.dispatchEvent(event);
};

/** Wait until the page settles, or fail after a bounded number of turns. A
 * mutant that never answers the door would otherwise hang the whole run
 * instead of failing the one test. */
export const waitUntilSettled = async (
  settled: () => boolean,
  what: string,
): Promise<void> => {
  for (let turn = 0; turn < 1000; turn++) {
    if (settled()) return;
    await Promise.resolve();
  }
  throw new Error(`${what} never settled`);
};

/** Run `use` while reading the page's `localStorage` throws `error`, as a
 * page whose browser blocks or breaks site data sees it. The store comes
 * back after `use` ends. */
export const whileStoreThrows = <T>(error: Error, use: () => T): T => {
  const descriptor = requireValue(
    Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    "No localStorage to block",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw error;
    },
  });
  try {
    return use();
  } finally {
    Object.defineProperty(globalThis, "localStorage", descriptor);
  }
};
