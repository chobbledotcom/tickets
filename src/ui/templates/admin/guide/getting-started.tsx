/**
 * Admin guide — GettingStarted sections.
 */

import { t } from "#i18n";
import { Faq, Section } from "#templates/admin/guide/components.tsx";

export const GettingStarted = (): JSX.Element => (
  <>
    <Section title={t("guide.sections.getting_started")}>
      <Faq id="create_listing" />

      <Faq id="setup_payments" />
    </Section>

    <Section title={t("guide.sections.dashboard")}>
      <Faq id="what_is_dashboard" />
    </Section>

    <Section title={t("guide.sections.testing_your_system")}>
      <Faq id="test_after_changing_settings" />

      <Faq id="report_bug" />
    </Section>
  </>
);
