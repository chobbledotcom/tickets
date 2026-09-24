import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { domainsSections } from "#templates/admin/guide/domains.tsx";

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
  expect(html).toContain("You pick the name, and the host sets the ending.");
  expect(html).toContain("only when your host offers subdomains");
  expect(html).not.toContain("site answers at");
});

test("the custom-domain answer notes when its section is absent", () => {
  const html = String(renderGuideSections(domainsSections()));
  expect(html).toContain(
    "The section appears only when your host runs on Bunny CDN.",
  );
});

test("the custom domain answer names the always-working fallback address", () => {
  const html = String(renderGuideSections(domainsSections()));
  expect(html).toContain("b-cdn.net</code> address. It always works.");
});
