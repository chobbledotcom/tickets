import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
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

/**
 * A public page that is a heading and one paragraph, named by the three
 * messages it shows. The messages are read when the page renders, so the
 * reader's own wording is used.
 */
export const messagePublicPage =
  (titleKey: string, headingKey: string, messageKey: string): (() => string) =>
  () =>
    simplePublicPage(t(titleKey), t(headingKey))(<p>{t(messageKey)}</p>);
