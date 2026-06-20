/**
 * Admin guide — GettingStarted sections.
 */

import { t } from "#i18n";
import { faq, type GuideSection } from "#templates/admin/guide/components.tsx";

export const gettingStartedSections = (): GuideSection[] => [
  {
    entries: [faq("create_listing"), faq("setup_payments")],
    title: t("guide.sections.getting_started"),
  },
  {
    entries: [faq("what_is_dashboard")],
    title: t("guide.sections.dashboard"),
  },
  {
    entries: [faq("test_after_changing_settings"), faq("report_bug")],
    title: t("guide.sections.testing_your_system"),
  },
];
