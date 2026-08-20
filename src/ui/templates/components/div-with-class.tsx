import type { Child } from "#jsx/jsx-runtime.ts";

/** Makes a component that wraps its children in a div with the given class —
 * the one mechanism behind fixed-class wrappers like `TableScroll` and
 * `Prose`. */
export const divWithClass =
  (className: string) =>
  ({ children }: { children: Child }): JSX.Element => (
    <div class={className}>{children}</div>
  );
