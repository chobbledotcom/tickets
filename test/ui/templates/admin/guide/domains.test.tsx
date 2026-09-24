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

test("the host subdomain answer shows the host's own suffix", () => {
  const html = String(
    renderGuideSections(
      domainsSections({
        builderEnabled: false,
        bunnyDnsSubdomainSuffix: ".tix.chobble.net",
        hostAppleWalletPassTypeId: null,
        hostEmailFromAddress: null,
        hostEmailProvider: null,
        hostGoogleWalletIssuerId: null,
      }),
    ),
  );
  expect(html).toContain("<code>your-name.tix.chobble.net</code>");
});

test("without host config the answer falls back to an example suffix", () => {
  const html = String(renderGuideSections(domainsSections()));
  expect(html).toContain("<code>your-name.example.com</code>");
});

test("the custom domain answer names the always-working b-cdn.net address", () => {
  const html = String(renderGuideSections(domainsSections()));
  expect(html).toContain(
    "b-cdn.net</code> address. That address always works.",
  );
});
