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
  cleanup: () => void;
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
    cleanup: (): void => {
      stash.restore();
      for (const window of openWindows) window.close();
      openWindows.length = 0;
    },
    installDom: (bodyHtml: string): Window => {
      const window = new Window({ url: "https://admin.test/" });
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
