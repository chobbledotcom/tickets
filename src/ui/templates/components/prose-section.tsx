/**
 * Shared `<section><div class="prose"><h2>{title}</h2>…</div>…</section>` shell.
 *
 * Many admin pages open with a prose block — an `<h2>` heading plus
 * introductory copy — sometimes followed by a form or table inside the same
 * `<section>`. This captures that skeleton so the prose/heading markup is
 * authored once. `children` is the prose body inside `.prose`; `footer` is
 * anything that belongs in the section *after* the prose block (a form, a
 * table, an `<em>` note).
 */

import type { Child } from "#jsx/jsx-runtime.ts";
import { PageBlock } from "#templates/components/page-layout.tsx";

export const ProseSection = ({
  title,
  children,
  footer,
}: {
  title: Child;
  /** Body rendered inside the `.prose` block, under the heading. */
  children?: Child;
  /** Extra content rendered after the `.prose` block, still inside the section. */
  footer?: Child;
}): JSX.Element => (
  <PageBlock>
    <div class="prose">
      <h2>{title}</h2>
      {children}
    </div>
    {footer}
  </PageBlock>
);
