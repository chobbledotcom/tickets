/**
 * The `<div class="prose"><h1>{heading}</h1>{children}</div>` opener many admin
 * pages start with — a top-level heading in a prose block, optionally followed
 * by intro copy or an actions row. Owning it here keeps that opener from being
 * re-authored (and re-detected as a clone) on every page that adopts it.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

export const ProseHeading = ({
  heading,
  children,
}: {
  heading: Child;
  children?: Child;
}): JSX.Element => (
  <div class="prose">
    <h1>{heading}</h1>
    {children}
  </div>
);
