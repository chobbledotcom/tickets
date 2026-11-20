// effects: pure
/** Which parts of the screen are dim. One thing has the focus: the page or
 * one window. Everything else is dim. */

/** What is dim. `page` is the page behind the windows. `windows` holds the
 * key of each dim window. */
export type ModalDimming = {
  readonly page: boolean;
  readonly windows: ReadonlySet<string>;
};

/** The dim parts for windows in stack order, bottom first. The top window
 * has the focus unless the page has it. With no window, nothing is dim. */
export const dimmingFor = (
  keys: readonly string[],
  pageFocused: boolean,
): ModalDimming => ({
  page: keys.length > 0 && !pageFocused,
  windows: new Set(pageFocused ? keys : keys.slice(0, -1)),
});
