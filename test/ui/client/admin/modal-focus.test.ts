/** The pure focus rule: who has the focus, and what is dim. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dimmingFor,
  EMPTY_SCREEN,
  type ModalFocus,
  type ModalScreen,
  type ScreenEvent,
  transitionScreen,
} from "#src/ui/client/admin/modal-focus.ts";

const at = { left: 0, top: 0 };
const screenOf = (keys: string[], focus: ModalFocus): ModalScreen => ({
  focus,
  windows: keys.map((key) => ({ expandedPoint: null, key, point: at })),
});

const keysOf = (screen: ModalScreen): string[] =>
  screen.windows.map(({ key }) => key);

const step = (screen: ModalScreen, event: ScreenEvent): ModalScreen =>
  transitionScreen(screen, event);

describe("the modal dimming rule", () => {
  test("dims nothing when no window is open", () => {
    expect(dimmingFor(EMPTY_SCREEN)).toEqual({
      page: false,
      windows: new Set(),
    });
  });

  test("a lone window with the focus is bright and the page is dim", () => {
    expect(dimmingFor(screenOf(["a"], "window"))).toEqual({
      page: true,
      windows: new Set(),
    });
  });

  test("the page with the focus is bright and every window is dim", () => {
    expect(dimmingFor(screenOf(["a", "b", "c"], "page"))).toEqual({
      page: false,
      windows: new Set(["a", "b", "c"]),
    });
  });

  test("only the top window is bright when a window has the focus", () => {
    expect(dimmingFor(screenOf(["a", "b", "c"], "window"))).toEqual({
      page: true,
      windows: new Set(["a", "b"]),
    });
  });

  test("exactly one thing is bright for every stack and focus", () => {
    for (const keys of [["a"], ["a", "b"], ["a", "b", "c"]]) {
      for (const focus of ["page", "window"] as const) {
        const { page, windows } = dimmingFor(screenOf(keys, focus));
        const brightWindows = keys.filter((key) => !windows.has(key));
        const brightPage = page ? [] : ["page"];
        expect([...brightWindows, ...brightPage]).toHaveLength(1);
      }
    }
    expect(dimmingFor(EMPTY_SCREEN).page).toBe(false);
  });
});

describe("the modal focus transitions", () => {
  test("a window that opens takes the focus from the page", () => {
    const opened = step(EMPTY_SCREEN, { key: "a", point: at, type: "open" });
    expect(opened.focus).toBe("window");
    expect(keysOf(opened)).toEqual(["a"]);

    const pressed = step(opened, { type: "focus-page" });
    expect(step(pressed, { key: "b", point: at, type: "open" }).focus).toBe(
      "window",
    );
  });

  test("a window that rises takes the focus from the page", () => {
    const pressed = screenOf(["a", "b"], "page");
    const raised = step(pressed, { key: "a", type: "raise" });
    expect(raised.focus).toBe("window");
    expect(keysOf(raised)).toEqual(["b", "a"]);
  });

  test("opening a window that is already open raises it and gives it the focus", () => {
    const reopened = step(screenOf(["a", "b"], "page"), {
      key: "a",
      point: at,
      type: "open",
    });
    expect(reopened.focus).toBe("window");
    expect(keysOf(reopened)).toEqual(["b", "a"]);
  });

  test("raising a window that is not open changes nothing", () => {
    const pressed = screenOf(["a"], "page");
    expect(step(pressed, { key: "b", type: "raise" })).toBe(pressed);
  });

  test("a press on the page gives the page the focus and moves nothing", () => {
    const focused = screenOf(["a", "b"], "window");
    const pressed = step(focused, { type: "focus-page" });
    expect(pressed.focus).toBe("page");
    expect(pressed.windows).toBe(focused.windows);
  });

  test("a press on the page changes nothing when the page has the focus or no window is open", () => {
    const pressed = screenOf(["a"], "page");
    expect(step(pressed, { type: "focus-page" })).toBe(pressed);
    expect(step(EMPTY_SCREEN, { type: "focus-page" })).toBe(EMPTY_SCREEN);
  });

  test("closing a window leaves the focus where it was, until the last window closes", () => {
    expect(
      step(screenOf(["a", "b"], "window"), { key: "b", type: "close" }).focus,
    ).toBe("window");
    expect(
      step(screenOf(["a", "b"], "page"), { key: "b", type: "close" }).focus,
    ).toBe("page");
    expect(
      step(screenOf(["a"], "window"), { key: "a", type: "close" }),
    ).toEqual(EMPTY_SCREEN);
  });

  test("moving, minimising, restoring and resizing leave the focus where it was", () => {
    const size = { height: 2, width: 2 };
    const viewport = { height: 9, width: 9 };
    const events: ScreenEvent[] = [
      { key: "a", point: { left: 1, top: 1 }, size, type: "move", viewport },
      { key: "a", type: "minimise" },
      { key: "a", size, type: "restore", viewport },
      { sizes: new Map([["a", size]]), type: "resize", viewport },
    ];
    for (const focus of ["page", "window"] as const) {
      let screen = screenOf(["a"], focus);
      for (const event of events) {
        screen = step(screen, event);
        expect(screen.focus).toBe(focus);
      }
    }
  });

  test("an event that changes nothing answers the same screen", () => {
    const screen = screenOf(["a", "b"], "window");
    expect(step(screen, { key: "b", type: "raise" })).toBe(screen);
    expect(step(screen, { key: "c", type: "close" })).toBe(screen);
  });
});
