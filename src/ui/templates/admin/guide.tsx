/**
 * Admin guide page — FAQ-style help for administrators, assembled from one
 * ordered list of {@link GuideSection}s. The schema, and the reason the guide
 * is data, are in ./guide/components.tsx.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { accountsSections } from "#templates/admin/guide/accounts.tsx";
import {
  type GuideHostConfig,
  type GuideSection,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import { domainsSections } from "#templates/admin/guide/domains.tsx";
import { emailSections } from "#templates/admin/guide/email.tsx";
import { gettingStartedSections } from "#templates/admin/guide/getting-started.tsx";
import { importExportSections } from "#templates/admin/guide/import-export.tsx";
import { integrationsSections } from "#templates/admin/guide/integrations.tsx";
import {
  listingsSections,
  textFormattingSection,
} from "#templates/admin/guide/listings.tsx";
import { operationsSections } from "#templates/admin/guide/operations.tsx";
import { paymentsSections } from "#templates/admin/guide/payments.tsx";
import { ticketsSections } from "#templates/admin/guide/tickets.tsx";
import type { AdminSession } from "#types";
/* jscpd:ignore-end */

/** The whole guide as one ordered list of sections. */
export const guideSections = (hostConfig?: GuideHostConfig): GuideSection[] => [
  ...gettingStartedSections(),
  ...listingsSections(),
  ...importExportSections(),
  ...paymentsSections(),
  ...ticketsSections(hostConfig),
  ...accountsSections(),
  ...emailSections(hostConfig),
  ...domainsSections(hostConfig),
  ...integrationsSections(),
  ...operationsSections(),
];

/**
 * Shared shell for the guide pages: the admin shell plus the prose heading that
 * both `adminGuidePage` and `adminFormattingHelpPage` wrap their sections in.
 */
type GuideShellProps = {
  active: string;
  heading: string;
  proseExtra?: Child;
  sections: JSX.Element;
  session: AdminSession;
  title: string;
};

const guideShell = ({
  active,
  heading,
  proseExtra,
  sections,
  session,
  title,
}: GuideShellProps): JSX.Element => (
  <AdminPage
    active={active}
    bodyClass="guide"
    contentClassName="guide-page"
    session={session}
    title={title}
  >
    <div class="prose">
      <h2>{heading}</h2>
      {proseExtra}
    </div>
    {sections}
  </AdminPage>
);

export const adminGuidePage = (
  adminSession: AdminSession,
  hostConfig?: GuideHostConfig,
): string =>
  String(
    guideShell({
      active: "/admin/guide",
      heading: t("guide.title"),
      proseExtra: <p class="search-hint">{t("guide.search_hint")}</p>,
      sections: renderGuideSections(guideSections(hostConfig)),
      session: adminSession,
      title: t("guide.title"),
    }),
  );

/**
 * Standalone markdown formatting-help page. The full guide is staff-only (its
 * body links to many owner/staff pages), but markdown formatting help is needed
 * by every content role — including editors — wherever a markdown field shows
 * the "Formatting help" hint. This renders just the editor-safe Text Formatting
 * section so that link never dead-ends.
 */
export const adminFormattingHelpPage = (adminSession: AdminSession): string =>
  String(
    guideShell({
      active: "",
      heading: t("guide.sections.text_formatting"),
      sections: renderGuideSections([textFormattingSection]),
      session: adminSession,
      title: t("guide.sections.text_formatting"),
    }),
  );
