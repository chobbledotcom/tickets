/**
 * Admin guide — Domains sections.
 */

import { t } from "#i18n";
import {
  Faq,
  type GuideHostConfig,
  Q,
  Section,
} from "#templates/admin/guide/components.tsx";

export const Domains = ({
  hostConfig,
}: {
  hostConfig?: GuideHostConfig;
}): JSX.Element => (
  <>
    <Section id="host-subdomain" title="Host Subdomain">
      <Q q="What is a host subdomain?">
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
        </p>
      </Q>

      <Faq id="how_do_i_register_a_subdomain" />

      <Faq id="can_i_use_both_a_subdomain_and" />
    </Section>

    <Section id="custom-domain" title={t("guide.sections.custom_domain")}>
      <Faq id="setup_custom_domain" />

      <Faq id="what_does_validation_do" />

      <Faq id="what_if_validation_fails" />

      <Faq id="which_domain_is_used_for_ticket_links" />
    </Section>

    <Section title={t("guide.sections.settings_overview")}>
      <Faq id="available_settings" />

      <Faq id="how_does_the_header_image_work" />

      <Faq id="advanced_settings" />

      <Faq id="what_is_debug_page" />

      <Faq id="what_is_the_debug_footer" />
    </Section>

    {hostConfig?.builderEnabled && (
      <Section id="built-sites" title="Built Sites">
        <Faq id="what_are_built_sites" />

        <Faq id="how_do_i_create_a_new_tickets" />

        <Faq id="what_do_i_need_before_building_a" />

        <Faq id="can_i_add_a_site_record_without" />
      </Section>
    )}
  </>
);
