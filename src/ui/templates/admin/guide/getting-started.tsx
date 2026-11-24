/**
 * Admin guide — GettingStarted sections.
 */

import {
  faq,
  faqSection,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const gettingStartedSections = (): GuideSection[] => [
  {
    entries: [faq("create_listing"), faq("setup_payments")],
    titleKey: "getting_started",
  },
  faqSection(
    "dashboard",
    ["what_is_dashboard", "group_cards_dashboard", "change_list_order"],
    "dashboard",
  ),
  {
    entries: [faq("test_after_changing_settings"), faq("report_bug")],
    titleKey: "testing_your_system",
  },
  faqSection(
    "getting_help",
    ["contact_support", "support_page_availability"],
    "support",
  ),
];
