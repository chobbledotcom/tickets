import type { Child } from "#jsx/jsx-runtime.ts";

/** An article that opens with its heading (and any text that belongs with it)
 * in a "prose" block, then shows the rest of the section — like a table —
 * below it. */
export const ProseArticle = ({
  heading,
  prose,
  children,
}: {
  /** The section's heading element (an `<h2>` or `<h3>`, with any id). */
  heading: JSX.Element;
  /** Text shown with the heading inside the prose block. */
  prose?: Child;
  /** Content shown after the prose block. */
  children?: Child;
}): JSX.Element => (
  <article>
    <div class="prose">
      {heading}
      {prose}
    </div>
    {children}
  </article>
);
