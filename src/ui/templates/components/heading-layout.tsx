import type { Child } from "#jsx/jsx-runtime.ts";
import { PageHeading } from "#templates/components/prose-heading.tsx";
import { Layout } from "#templates/layout.tsx";
import type { PageFamily } from "#templates/page-family.ts";

/** The one full-page shell that opens with a heading: the site Layout, the
 * heading element, then the body. The heading-first pages (the prose pages,
 * the ticket confirmation, the flow-complete page) all fold into it, so the
 * Layout prop block exists once. */
export const HeadingShell = ({
  children,
  contentClassName,
  family,
  opener,
  title,
}: {
  children: Child;
  contentClassName?: string | undefined;
  family: PageFamily;
  opener: Child;
  title: string;
}): JSX.Element => (
  <Layout contentClassName={contentClassName} family={family} title={title}>
    {opener}
    {children}
  </Layout>
);

export const HeadingLayout = ({
  title,
  heading,
  children,
  family,
}: {
  title: string;
  heading: string;
  children: Child;
  family: PageFamily;
}): JSX.Element => (
  <HeadingShell
    family={family}
    opener={<PageHeading heading={heading} />}
    title={title}
  >
    {children}
  </HeadingShell>
);

/** Curried page builder: give it the heading, title, and family, then the
 *  body, and get the finished HTML string. Shared by the pages that render a
 *  {@link HeadingLayout} straight to a string (the ticket confirmation and the
 *  "flow complete" page). */
export const headingLayoutPage =
  (heading: string, title: string, family: PageFamily) =>
  (body: Child): string =>
    String(
      <HeadingLayout family={family} heading={heading} title={title}>
        {body}
      </HeadingLayout>,
    );
