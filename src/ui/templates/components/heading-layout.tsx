/**
 * A page Layout that opens with a single `<h1>` heading, then the given body.
 * Shared by the ticket confirmation page and the "flow complete" page so both
 * frame their content the same way.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
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
    <h1>{heading}</h1>
    {children}
  </Layout>
);
