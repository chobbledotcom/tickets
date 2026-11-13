/**
 * A `prose` intro block: the translated heading and intro paragraph that
 * several admin pages open with, before their own content takes over.
 * `headingTag` sizes the heading (h2 for section pages, h3 for panels).
 * `children` renders any extra intro content inside the same block. `class`
 * restyles the block when a page needs its own (default `prose`).
 * Unlike {@link ProseArticle}, nothing wraps the block. The output is the
 * bare `div.prose`, so a page keeps its own section/fieldset structure.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

export const ProseIntro = ({
  children,
  class: className = "prose",
  heading,
  headingTag = "h2",
  intro,
}: {
  children?: Child;
  class?: string;
  heading: string;
  headingTag?: "h2" | "h3";
  intro: string;
}): JSX.Element => {
  const Heading = headingTag;
  return (
    <div class={className}>
      <Heading>{heading}</Heading>
      <p>{intro}</p>
      {children}
    </div>
  );
};
