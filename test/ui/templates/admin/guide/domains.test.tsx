import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type GuideHostConfig,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import { domainsSections } from "#templates/admin/guide/domains.tsx";

/** A host that has nothing switched on, so each test names only the one
 * setting it is about. */
const host = (overrides: Partial<GuideHostConfig> = {}): GuideHostConfig => ({
  builderEnabled: false,
  bunnyDnsSubdomainSuffix: null,
  hostAppleWalletPassTypeId: null,
  hostEmailFromAddress: null,
  hostEmailProvider: null,
  hostGoogleWalletIssuerId: null,
  ...overrides,
});

const sectionIds = (hostConfig?: GuideHostConfig) =>
  domainsSections(hostConfig).map(({ id }) => id);

const entryIds = (
  sectionId: string,
  hostConfig?: GuideHostConfig,
): string[] => {
  const section = domainsSections(hostConfig).find(
    ({ id }) => id === sectionId,
  );
  if (section === undefined) throw new Error(`No ${sectionId} guide section`);
  return section.entries.map((entry) =>
    "faq" in entry ? entry.faq : entry.custom,
  );
};

describe("domains guide schema", () => {
  test("keeps every domains section in its intended order", () => {
    expect(sectionIds(host({ builderEnabled: true }))).toEqual([
      "host-subdomain",
      "custom-domain",
      "settings",
      "built-sites",
    ]);
  });

  test("drops the built-sites section on a host that cannot build", () => {
    expect(sectionIds()).not.toContain("built-sites");
    expect(sectionIds(host({ builderEnabled: false }))).not.toContain(
      "built-sites",
    );
  });

  test("answers the built-site questions in order, renewal tier last", () => {
    expect(entryIds("built-sites", host({ builderEnabled: true }))).toEqual([
      "what_are_built_sites",
      "how_do_i_create_a_new_tickets",
      "what_do_i_need_before_building_a",
      "can_i_add_a_site_record_without",
      "how_do_i_set_a_sites_renewal_tier",
    ]);
  });

  test("shows the host's own subdomain suffix, or a placeholder without one", () => {
    const withSuffix = renderGuideSections(
      domainsSections(host({ bunnyDnsSubdomainSuffix: ".tickets.example" })),
    );
    expect(String(withSuffix)).toContain("my-business.tickets.example");
    expect(String(withSuffix)).not.toContain(".example.com");

    expect(String(renderGuideSections(domainsSections()))).toContain(
      "my-business.example.com",
    );
  });
});
