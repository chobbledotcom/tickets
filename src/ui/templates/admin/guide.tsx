/**
 * Admin guide page — FAQ-style help for administrators.
 *
 * This is a thin shell: each topic's sections live in ./guide/<topic>.tsx and
 * the shared Section/Q/Faq primitives live in ./guide/components.tsx. Most
 * answers are authored in guide.a.* locale keys and rendered via <Faq>; the
 * sections that vary by site configuration keep manual <Q> blocks.
 */

import { t } from "#i18n";
import type { AdminSession } from "#shared/types.ts";
import { Accounts } from "#templates/admin/guide/accounts.tsx";
import type { GuideHostConfig } from "#templates/admin/guide/components.tsx";
import { Domains } from "#templates/admin/guide/domains.tsx";
import { Email } from "#templates/admin/guide/email.tsx";
import { GettingStarted } from "#templates/admin/guide/getting-started.tsx";
import { Integrations } from "#templates/admin/guide/integrations.tsx";
import { Listings } from "#templates/admin/guide/listings.tsx";
import { Operations } from "#templates/admin/guide/operations.tsx";
import { Payments } from "#templates/admin/guide/payments.tsx";
import { Tickets } from "#templates/admin/guide/tickets.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

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

      <GettingStarted />
      <Listings />
      <Payments />
      <Tickets hostConfig={hostConfig} />
      <Accounts />
      <Email hostConfig={hostConfig} />
      <Domains hostConfig={hostConfig} />
      <Integrations />
      <Operations />
    </Layout>,
  );
