/**
 * Admin guide — Domains sections.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import {
  custom,
  faq,
  type GuideHostConfig,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const domainsSections = (hostConfig?: GuideHostConfig): GuideSection[] =>
  compact<GuideSection>([
    {
      entries: [
        custom(
          "What is a host subdomain?",
          <p>
            If your server administrator has enabled subdomain registration, you
            can claim a pretty subdomain for your tickets site (e.g.{" "}
            <code>
              my-business
              {hostConfig?.bunnyDnsSubdomainSuffix || ".example.com"}
            </code>
            ) instead of using the default CDN hostname. The option appears in{" "}
            <strong>Advanced Settings</strong> under{" "}
            <strong>Host Subdomain</strong>.
          </p>,
        ),
        faq("how_do_i_register_a_subdomain"),
        faq("can_i_use_both_a_subdomain_and"),
      ],
      id: "host-subdomain",
      title: "Host Subdomain",
    },
    {
      entries: [
        faq("setup_custom_domain"),
        faq("what_does_validation_do"),
        faq("what_if_validation_fails"),
        faq("which_domain_is_used_for_ticket_links"),
      ],
      id: "custom-domain",
      title: t("guide.sections.custom_domain"),
    },
    {
      entries: [
        faq("available_settings"),
        faq("how_does_the_header_image_work"),
        faq("advanced_settings"),
        faq("what_is_debug_page"),
        faq("what_is_the_debug_footer"),
      ],
      title: t("guide.sections.settings_overview"),
    },
    hostConfig?.builderEnabled
      ? {
          entries: [
            faq("what_are_built_sites"),
            faq("how_do_i_create_a_new_tickets"),
            faq("what_do_i_need_before_building_a"),
            faq("can_i_add_a_site_record_without"),
          ],
          id: "built-sites",
          title: "Built Sites",
        }
      : null,
  ]);
