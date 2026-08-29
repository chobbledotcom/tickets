/**
 * Shared `<section><div class="prose"><h2>{title}</h2>…</div>…</section>` shell.
 *
 * Many admin pages open with a prose block — an `<h2>` heading plus
 * introductory copy — sometimes followed by a form or table inside the same
 * `<section>`. This captures that skeleton so the prose/heading markup is
 * authored once. `children` is the prose body inside `.prose`; `footer` is
 * anything that belongs in the section *after* the prose block (a form, a
 * table, an `<em>` note). A page whose sections are already laid out by the
 * page grid passes `bare` to drop the `page-block` padding.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

export const ProseSection = ({
  title,
  headingTag: Heading = "h2",
  children,
  footer,
  bare = false,
}: {
  title: Child;
  /** Heading tag for the title — the surrounding page decides the level
   * (defaults to `h2`; a nested panel passes a deeper one). */
  headingTag?: "h2" | "h3" | "h4";
  /** Body rendered inside the `.prose` block, under the heading. */
  children?: Child;
  /** Extra content rendered after the `.prose` block, still inside the section. */
  footer?: Child;
  /** Render the bare `<section>` without the page-block padding class. */
  bare?: boolean;
}): JSX.Element => (
  <section class={bare ? undefined : "page-block"}>
    <div class="prose">
      <Heading>{title}</Heading>
      {children}
    </div>
    {footer}
  </section>
);
