import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { emailSections } from "#templates/admin/guide/email.tsx";
import { LOOP_EXAMPLE } from "#templates/components/email-template-reference.tsx";
import {
  expectVariablesShown,
  shown,
} from "#test-utils/email-template-reference.ts";

const renderEmailGuide = (): string =>
  String(renderGuideSections(emailSections()));

const hostWithEmail = {
  builderEnabled: false,
  bunnyDnsSubdomainSuffix: null,
  hostAppleWalletPassTypeId: null,
  hostEmailFromAddress: "host@example.com",
  hostEmailProvider: "Host Mail",
  hostGoogleWalletIssuerId: null,
};

describe("guide > email sections", () => {
  test("the variables entry shows every declared variable with its description", () => {
    expectVariablesShown(renderEmailGuide());
  });

  test("the variables entry shows the worked loop", () => {
    expect(renderEmailGuide()).toContain(
      `<pre><code>${shown(LOOP_EXAMPLE)}</code></pre>`,
    );
  });

  test("the host email note renders with its links and joins intact", () => {
    const html = String(renderGuideSections(emailSections(hostWithEmail)));
    expect(html).toContain(
      "using <strong>Host Mail</strong> with from address <code>host@example.com</code>. You can override",
    );
    expect(html).toContain(
      'API key in <a href="/admin/settings-advanced#settings-email">Advanced Settings</a>. If you provide',
    );
  });

  test("the setup steps and section anchors render exactly", () => {
    const html = renderEmailGuide();
    expect(html).toContain(
      'Go to <a href="/admin/settings-advanced#settings-email">Advanced Settings</a> and find the <strong>Email</strong> section',
    );
    expect(html).toContain("into the <strong>API Key</strong> field");
    expect(html).toContain('<h3 id="email">');
    expect(html).toContain('<h3 id="email-templates">');
    expect(html).toContain('<h3 id="bulk-email">');
  });

  test("the filters entry names both filters with their examples", () => {
    const html = renderEmailGuide();
    expect(html).toContain(
      "<code>{{ amount | currency }}</code> — formats a number",
    );
    expect(html).toContain(
      "<code>{{ count | pluralize: &quot;ticket&quot;, &quot;tickets&quot; }}</code> — returns the singular",
    );
    expect(html).toContain(
      "<code>{{ listing_names }}</code> — All listing names, joined with &quot;and&quot;",
    );
  });

  test("every settings link opens the advanced settings page", () => {
    const html = renderEmailGuide();
    expect(html).not.toContain('href="/admin/settings"');
    expect(html).toContain('href="/admin/settings-advanced#settings-email"');
  });
});
