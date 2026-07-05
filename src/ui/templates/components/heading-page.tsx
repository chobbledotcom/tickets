/**
 * A page that is just the base {@link Layout} with a top-level heading and one
 * block of content below it. Shared by the finished-flow page (setup/join
 * complete) and the tickets page — each passes its own content as children.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

export const HeadingPage = ({
  title,
  heading,
  children,
}: {
  title: string;
  heading: string;
  children?: Child;
}): string =>
  String(
    <Layout title={title}>
      <h1>{heading}</h1>
      {children}
    </Layout>,
  );
