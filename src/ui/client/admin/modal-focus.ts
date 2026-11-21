// effects: pure
/** The windows and the focus. One thing has the focus: the page or the top
 * window. Everything else is dim. The window order and positions come from
 * `transitionModals`. This module adds the focus and the dim. */

import {
  type ModalEvent,
  type ModalState,
  transitionModals,
} from "./modal-state.ts";

/** Who has the focus. With no window open the page has it. */
export type ModalFocus = "page" | "window";

/** The windows, bottom first, and who has the focus. */
export type ModalScreen = {
  readonly windows: readonly ModalState[];
  readonly focus: ModalFocus;
};

/** A press or focus on the page gives the page the focus. It moves nothing. */
export type ScreenEvent = ModalEvent | { type: "focus-page" };

export const EMPTY_SCREEN: ModalScreen = { focus: "page", windows: [] };

/** A window that opens or rises takes the focus. The last window to close
 * hands it to the page. Every other event leaves the focus where it is. */
const focusAfter = (
  screen: ModalScreen,
  windows: readonly ModalState[],
  event: ScreenEvent,
): ModalFocus => {
  if (windows.length === 0) return "page";
  if (event.type !== "open" && event.type !== "raise") return screen.focus;
  return windows.some(({ key }) => key === event.key) ? "window" : screen.focus;
};

/** The next screen. A step that changes nothing answers the same object. */
export const transitionScreen = (
  screen: ModalScreen,
  event: ScreenEvent,
): ModalScreen => {
  if (event.type === "focus-page") {
    return screen.windows.length === 0 || screen.focus === "page"
      ? screen
      : { ...screen, focus: "page" };
  }
  const windows = transitionModals(screen.windows, event);
  const focus = focusAfter(screen, windows, event);
  return windows === screen.windows && focus === screen.focus
    ? screen
    : { focus, windows };
};

/** What is dim. `page` is the page behind the windows. `windows` holds the
 * key of each dim window. */
export type ModalDimming = {
  readonly page: boolean;
  readonly windows: ReadonlySet<string>;
};

/** The dim parts. The top window is bright while it has the focus, and the
 * page is bright while it has the focus. With no window, nothing is dim. */
export const dimmingFor = ({ focus, windows }: ModalScreen): ModalDimming => ({
  page: windows.length > 0 && focus === "window",
  windows: new Set(
    (focus === "page" ? windows : windows.slice(0, -1)).map(({ key }) => key),
  ),
});
