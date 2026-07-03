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
