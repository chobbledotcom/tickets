import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type GuideHostConfig,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import { domainsSections } from "#templates/admin/guide/domains.tsx";

const hostConfig = (
  overrides: Partial<GuideHostConfig> = {},
): GuideHostConfig => ({
  builderEnabled: true,
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
          "what_is_a_domain_name",
          "where_do_i_buy_a_domain_name",
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

  test("drops the built-sites section when the builder is off", () => {
    const ids = domainsSections(hostConfig({ builderEnabled: false })).map(
      ({ id }) => id,
    );
    expect(ids).toEqual(["host-subdomain", "custom-domain", "settings"]);
  });
});

test("the sections keep the anchors the settings page links to", () => {
  const html = String(renderGuideSections(domainsSections()));
  // The advanced-settings intro deep-links these two anchors.
  expect(html).toContain('<h3 id="host-subdomain">');
  expect(html).toContain('<h3 id="custom-domain">');
  // The settings-overview section carries its own anchor too.
  expect(html).toContain('<h3 id="settings">');
});

test("the host subdomain answer does not promise the ending", () => {
  const html = String(renderGuideSections(domainsSections()));
  // The host sets the DNS zone, so only the check can name the full address.
  expect(html).toContain("You pick the first part of the name");
  expect(html).toContain("sets the ending");
  expect(html).toContain("only when your host offers subdomains");
  expect(html).not.toContain("site answers at");
});

test("the custom-domain answer notes when its section is absent", () => {
  const html = String(renderGuideSections(domainsSections()));
  expect(html).toContain(
    "ask the company that runs this site for you to turn it on",
  );
});

test("the out-of-stock answer gates its promises on an email provider", () => {
  const html = String(renderGuideSections(domainsSections(hostConfig())));
  expect(html).toContain("When email is set up");
  // The Built Sites page is owner-only, so the answer must not link it.
  expect(html).not.toContain('href="/admin/built-sites"');
  expect(html).toContain("Built Sites");
});

test("the answers name the request-hostname fallback", () => {
  const html = String(renderGuideSections(domainsSections()));
  // The system keeps the raw request hostname — a bunny.run request keeps
  // bunny.run links — so the copy must not claim a fixed b-cdn.net address.
  expect(html).toContain("the address the visitor used to open the site");
  expect(html).toContain("b-cdn.net</code> or <code>bunny.run</code>");
});
