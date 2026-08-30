/**
 * The `<div class="prose"><h1>{heading}</h1>{children}</div>` opener many admin
 * pages start with — a top-level heading in a prose block, optionally followed
 * by intro copy or an actions row. Owning it here keeps that opener from being
 * re-authored (and re-detected as a clone) on every page that adopts it.
 */

import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { divWithClass } from "#templates/components/div-with-class.tsx";

/** A `<div class="prose">` block — the standard prose styling wrapper the
 *  components below share. */
const Prose: (props: { children: Child }) => JSX.Element =
  divWithClass("prose");

/** A top-level `<h1>` page heading. Shared by the page {@link HeadingLayout}
 *  and the prose {@link ProseHeading} so the heading itself is authored once
 *  rather than re-written (and re-detected as a clone) in each wrapper. */
export const PageHeading = ({ heading }: { heading: Child }): JSX.Element => (
  <h1>{heading}</h1>
);

export const ProseHeading = ({
  heading,
  children,
}: {
  heading: Child;
  children?: Child;
}): JSX.Element => (
  <Prose>
    <PageHeading heading={heading} />
    {children}
  </Prose>
);

/** Props carrying a single trusted HTML string. */
type HtmlProps = { html: string };

/** One paragraph of trusted HTML — `<p><Raw html=.../></p>`. Owned here so the
 *  same `<p>`-wrapped `<Raw>` isn't re-authored (and re-detected as a clone)
 *  wherever a page drops a rich-text paragraph into a prose block. */
export const RawParagraph = ({ html }: HtmlProps): JSX.Element => (
  <p>
    <Raw html={html} />
  </p>
);

/** A single prose paragraph rendered from a trusted HTML string — the
 * `<div class="prose"><p><Raw html=.../></p></div>` intro block several admin
 * pages open with. Owning it here keeps that shape from being re-authored (and
 * re-detected as a clone) per page. */
export const ProseIntro = ({ html }: HtmlProps): JSX.Element => (
  <Prose>
    <RawParagraph html={html} />
  </Prose>
);
