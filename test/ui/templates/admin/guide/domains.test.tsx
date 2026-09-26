import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { domainsSections } from "#templates/admin/guide/domains.tsx";

const hostConfig = (
  overrides: Partial<{
    bunnyDnsSubdomainSuffix: string | null;
    builderEnabled: boolean;
    hostAppleWalletPassTypeId: string | null;
    hostEmailFromAddress: string | null;
    hostEmailProvider: string | null;
    hostGoogleWalletIssuerId: string | null;
  }> = {},
) => ({
  builderEnabled: true,
  bunnyDnsSubdomainSuffix: null,
  hostAppleWalletPassTypeId: null,
  hostEmailFromAddress: null,
  hostEmailProvider: null,
  hostGoogleWalletIssuerId: null,
  ...overrides,
});

describe("guide domains sections", () => {
  test("pins every section, its title key, and its entries in order", () => {
    const described = domainsSections(hostConfig()).map(
      ({ entries, id, titleKey }) => ({
        entries: entries.map((entry) =>
          "faq" in entry ? entry.faq : entry.custom,
        ),
        id,
        titleKey,
      }),
    );

    expect(described).toEqual([
      {
        entries: [
          "what_is_host_subdomain",
          "how_do_i_register_a_subdomain",
          "can_i_use_both_a_subdomain_and",
        ],
        id: "host-subdomain",
        titleKey: "host_subdomain",
      },
      {
        entries: [
          "setup_custom_domain",
          "what_does_validation_do",
          "what_if_validation_fails",
          "which_domain_is_used_for_ticket_links",
        ],
        id: "custom-domain",
        titleKey: "custom_domain",
      },
      {
        entries: [
          "available_settings",
          "how_does_the_header_image_work",
          "advanced_settings",
          "what_is_debug_page",
          "what_is_the_debug_footer",
        ],
        id: "settings",
        titleKey: "settings_overview",
      },
      {
        entries: [
          "what_are_built_sites",
          "how_do_i_create_a_new_tickets",
          "what_do_i_need_before_building_a",
          "can_i_add_a_site_record_without",
          "what_happens_when_a_site_plan",
        ],
        id: "built-sites",
        titleKey: "built_sites",
      },
    ]);
  });

  test("renders the host-subdomain example with and without a suffix", () => {
    const noSuffix = domainsSections(hostConfig())[0]!.entries[0]!;
    if (!("custom" in noSuffix)) throw new Error("expected a custom entry");
    expect(String(noSuffix.body)).toContain("my-business.example.com");

    const configured = domainsSections(
      hostConfig({ bunnyDnsSubdomainSuffix: ".chirp.zone" }),
    )[0]!.entries[0]!;
    if (!("custom" in configured)) throw new Error("expected a custom entry");
    expect(String(configured.body)).toContain("my-business.chirp.zone");
    expect(String(configured.body)).not.toContain("my-business.example.com");
  });

  test("drops the built-sites section when the builder is off", () => {
    const ids = domainsSections(hostConfig({ builderEnabled: false })).map(
      ({ id }) => id,
    );
    expect(ids).toEqual(["host-subdomain", "custom-domain", "settings"]);
  });
});
