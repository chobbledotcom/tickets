/**
 * The `<div class="prose"><h1>{heading}</h1>{children}</div>` opener many admin
 * pages start with — a top-level heading in a prose block, optionally followed
 * by intro copy or an actions row. Owning it here keeps that opener from being
 * re-authored (and re-detected as a clone) on every page that adopts it.
 */

import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";

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

/** A single prose paragraph rendered from a trusted HTML string — the
 *  `<div class="prose"><p><Raw html=.../></p></div>` intro block several admin
 *  pages open with. Owning it here keeps that shape from being re-authored (and
 *  re-detected as a clone) per page. */
export const ProseIntro = ({ html }: { html: string }): JSX.Element => (
  <div class="prose">
    <p>
      <Raw html={html} />
    </p>
  </div>
);
