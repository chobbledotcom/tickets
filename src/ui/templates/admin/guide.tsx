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
  ...paymentsSections(),
  ...ticketsSections(hostConfig),
  ...accountsSections(),
  ...emailSections(hostConfig),
  ...domainsSections(hostConfig),
  ...integrationsSections(),
  ...operationsSections(),
];

export const adminGuidePage = (
  adminSession: AdminSession,
  hostConfig?: GuideHostConfig,
): string =>
  String(
    <Layout bodyClass="guide" title={t("guide.title")}>
      <AdminNav active="/admin/guide" session={adminSession} />

      <div class="prose">
        <h2>{t("guide.title")}</h2>

        <p class="search-hint">
          Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>&#8984;</kbd>+<kbd>F</kbd>{" "}
          on Mac) to search this page.
        </p>
      </div>

      {renderGuideSections(guideSections(hostConfig))}
    </Layout>,
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
    <Layout bodyClass="guide" title={t("guide.sections.text_formatting")}>
      <AdminNav active="" session={adminSession} />
      <div class="prose">
        <h2>{t("guide.sections.text_formatting")}</h2>
      </div>
      {renderGuideSections([textFormattingSection])}
    </Layout>,
  );
