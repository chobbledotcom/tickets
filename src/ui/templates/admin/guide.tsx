/**
 * Admin guide page — FAQ-style help for administrators.
 *
 * The page is assembled from a single ordered list of guide sections (see
 * `guideSections`). Each topic module contributes a `GuideSection[]`; the shared
 * `renderGuideSections` turns that schema into the FAQ accordion markup, and the
 * Section/Q/Faq primitives live in ./guide/components.tsx. Authoring the guide as
 * data — rather than hand-nested JSX — is deliberate: a section can only ever be
 * a top-level list item, so a sub-section can never be nested mid-list and pull
 * unrelated questions under the wrong heading. Most answers are authored in
 * guide.a.* locale keys (data-driven `faq(...)` entries); the answers that vary
 * by site configuration are `custom(...)` entries with a bespoke body.
 */

import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
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
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

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
 * Shared shell for the guide pages: the Layout + AdminNav + prose heading that
 * both `adminGuidePage` and `adminFormattingHelpPage` wrap their sections in.
 * `AdminPage` (admin-page.tsx) is intentionally not reused here because it does
 * not support `bodyClass`.
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
  <Layout bodyClass="guide" title={title}>
    <AdminNav active={active} session={session} />
    <div class="prose">
      <h2>{heading}</h2>
      {proseExtra}
    </div>
    {sections}
  </Layout>
);

export const adminGuidePage = (
  adminSession: AdminSession,
  hostConfig?: GuideHostConfig,
): string =>
  String(
    guideShell({
      active: "/admin/guide",
      heading: t("guide.title"),
      proseExtra: (
        <p class="search-hint">
          Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>&#8984;</kbd>+<kbd>F</kbd>{" "}
          on Mac) to search this page.
        </p>
      ),
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
