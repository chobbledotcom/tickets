/** The pure focus rule: which parts of the screen are dim. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { dimmingFor } from "#src/ui/client/admin/modal-focus.ts";

describe("the modal dimming rule", () => {
  test("dims nothing when no window is open", () => {
    expect(dimmingFor([], false)).toEqual({ page: false, windows: new Set() });
    expect(dimmingFor([], true)).toEqual({ page: false, windows: new Set() });
  });

  test("a lone window with the focus is bright and the page is dim", () => {
    expect(dimmingFor(["a"], false)).toEqual({
      page: true,
      windows: new Set(),
    });
  });

  test("the page with the focus is bright and every window is dim", () => {
    expect(dimmingFor(["a", "b", "c"], true)).toEqual({
      page: false,
      windows: new Set(["a", "b", "c"]),
    });
  });

  test("only the top window is bright when a window has the focus", () => {
    expect(dimmingFor(["a", "b", "c"], false)).toEqual({
      page: true,
      windows: new Set(["a", "b"]),
    });
  });

  test("exactly one thing is bright for every stack and focus", () => {
    for (const keys of [[], ["a"], ["a", "b"], ["a", "b", "c"]]) {
      for (const pageFocused of [false, true]) {
        const { page, windows } = dimmingFor(keys, pageFocused);
        const brightWindows = keys.filter((key) => !windows.has(key));
        const brightPage = page ? [] : ["page"];
        expect([...brightWindows, ...brightPage]).toHaveLength(1);
      }
    }
  });
});
