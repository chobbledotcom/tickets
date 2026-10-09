import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { HeadingShell } from "#templates/components/heading-layout.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import type { PageFamily } from "#templates/page-family.ts";

/** Render a headed prose block, followed by optional page content. The
 * family defaults to `public` because almost every prose page is one. */
export const prosePage =
  (title: string, heading: string, family: PageFamily = "public") =>
  (prose: Child, afterProse?: Child): string =>
    String(
      <HeadingShell
        contentClassName="public-page"
        family={family}
        opener={<ProseHeading heading={heading}>{prose}</ProseHeading>}
        title={title}
      >
        {afterProse}
      </HeadingShell>,
    );

/** Render a simple page whose whole body sits inside its prose block. */
export const simplePublicPage =
  (title: string, heading: string, family: PageFamily = "public") =>
  (body: Child): string =>
    prosePage(title, heading, family)(body);

/**
 * A public page that is a heading and one paragraph, named by the three
 * messages it shows. The messages are read when the page renders, so the
 * reader's own wording is used.
 */
export const messagePublicPage =
  (titleKey: string, headingKey: string, messageKey: string): (() => string) =>
  () =>
    simplePublicPage(t(titleKey), t(headingKey))(<p>{t(messageKey)}</p>);
