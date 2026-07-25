import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import { Layout } from "#templates/layout.tsx";

/** Render a headed prose block, followed by optional page content. */
export const prosePage =
  (title: string, heading: string) =>
  (prose: Child, afterProse?: Child): string =>
    String(
      <Layout contentClassName="public-page" title={title}>
        <ProseHeading heading={heading}>{prose}</ProseHeading>
        {afterProse}
      </Layout>,
    );

/** Render a simple page whose whole body sits inside its prose block. */
export const simplePublicPage =
  (title: string, heading: string) =>
  (body: Child): string =>
    prosePage(title, heading)(body);
