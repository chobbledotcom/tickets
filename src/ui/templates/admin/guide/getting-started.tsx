/**
 * Admin guide — GettingStarted sections.
 */

import { faq, type GuideSection } from "#templates/admin/guide/components.tsx";

export const gettingStartedSections = (): GuideSection[] => [
  {
    entries: [faq("create_listing"), faq("setup_payments")],
    titleKey: "getting_started",
  },
  {
    entries: [faq("what_is_dashboard")],
    titleKey: "dashboard",
  },
  {
    entries: [faq("test_after_changing_settings"), faq("report_bug")],
    titleKey: "testing_your_system",
  },
];
