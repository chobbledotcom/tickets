/**
 * Admin guide — Domains sections.
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { formatBytes } from "#shared/format-units.ts";
import { MAX_IMAGE_SIZE } from "#shared/limits.ts";
import {
  custom,
  faq,
  type GuideHostConfig,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
/* jscpd:ignore-end */

export const domainsSections = (hostConfig?: GuideHostConfig): GuideSection[] =>
  compact<GuideSection>([
    {
      entries: [
        faq("what_is_host_subdomain"),
        faq("how_do_i_register_a_subdomain"),
        faq("can_i_use_both_a_subdomain_and"),
      ],
      id: "host-subdomain",
      titleKey: "host_subdomain",
    },
    {
      entries: [
        faq("what_is_a_domain_name"),
        faq("where_do_i_buy_a_domain_name"),
        faq("setup_custom_domain"),
        faq("what_does_validation_do"),
        faq("what_if_validation_fails"),
        faq("which_domain_is_used_for_ticket_links"),
      ],
      id: "custom-domain",
      titleKey: "custom_domain",
    },
    {
      entries: [
        faq("available_settings"),
        custom(
          "how_does_the_header_image_work",
          <>
            <p>
              Upload a logo or banner from <strong>Settings</strong> and it
              appears at the top of every page.
            </p>
            <p>
              When your booking form is shown inside another website, the image
              is hidden. That website already shows its own branding.
            </p>
            <p>
              You can use JPEG, PNG, or WebP pictures, up to{" "}
              {formatBytes(MAX_IMAGE_SIZE)} in size. Uploading a new image
              replaces the old one, and the <strong>Remove Image</strong> button
              clears it completely. The picture is stored scrambled, and each
              visitor's browser keeps a copy so it only downloads once.
            </p>
            <p>
              If the section is missing, your host has not turned on image
              storage. Ask them to set up a Bunny storage zone for your site.
            </p>
          </>,
        ),
        faq("advanced_settings"),
        faq("what_is_debug_page"),
        faq("what_is_the_debug_footer"),
      ],
      id: "settings",
      titleKey: "settings_overview",
    },
    hostConfig?.builderEnabled
      ? {
          entries: [
            faq("what_are_built_sites"),
            faq("how_do_i_create_a_new_tickets"),
            faq("what_do_i_need_before_building_a"),
            faq("can_i_add_a_site_record_without"),
            faq("what_happens_when_a_site_plan"),
          ],
          id: "built-sites",
          titleKey: "built_sites",
        }
      : null,
  ]);
