/**
 * A page Layout that opens with a single `<h1>` heading, then the given body.
 * Shared by the ticket confirmation page and the "flow complete" page so both
 * frame their content the same way.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { PageHeading } from "#templates/components/prose-heading.tsx";
import { Layout } from "#templates/layout.tsx";

export const HeadingLayout = ({
  title,
  heading,
  children,
}: {
  title: string;
  heading: string;
  children: Child;
}): JSX.Element => (
  <Layout title={title}>
    <PageHeading heading={heading} />
    {children}
  </Layout>
);

/** Curried page builder: give it the heading and title, then the body, and get
 *  the finished HTML string. Shared by the pages that render a {@link
 *  HeadingLayout} straight to a string (the ticket confirmation and the "flow
 *  complete" page). */
export const headingLayoutPage =
  (heading: string, title: string) =>
  (body: Child): string =>
    String(
      <HeadingLayout heading={heading} title={title}>
        {body}
      </HeadingLayout>,
    );
