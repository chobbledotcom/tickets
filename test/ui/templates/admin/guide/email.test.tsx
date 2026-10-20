import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
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

  test("the variables entry shows the worked loop and the availability note", () => {
    const html = renderEmailGuide();
    assertStringIncludes(
      html,
      `<pre><code>${shown(LOOP_EXAMPLE)}</code></pre>`,
    );
    assertStringIncludes(
      html,
      t("settings.advanced.email_variables.not_available"),
    );
  });

  test("the host email note renders with its links and joins intact", () => {
    const html = String(renderGuideSections(emailSections(hostWithEmail)));
    assertStringIncludes(
      html,
      "using <strong>Host Mail</strong> and the address <code>host@example.com</code>. You can use your own company instead",
    );
    assertStringIncludes(
      html,
      'enter it in <a href="/admin/settings-advanced#settings-email">Advanced Settings</a>. Your own settings come first',
    );
  });

  test("the setup steps and section anchors render exactly", () => {
    const html = renderEmailGuide();
    assertStringIncludes(
      html,
      'Go to <a href="/admin/settings-advanced#settings-email">Advanced Settings</a> and find the <strong>Email</strong> section',
    );
    assertStringIncludes(html, "Choose your email company from the dropdown");
    assertStringIncludes(html, '<h3 id="email">');
    assertStringIncludes(html, '<h3 id="email-templates">');
    assertStringIncludes(html, '<h3 id="bulk-email">');
  });

  test("the filters entry names both filters with their examples", () => {
    const html = renderEmailGuide();
    assertStringIncludes(
      html,
      "<code>{{ amount | currency }}</code> — formats a number",
    );
    assertStringIncludes(
      html,
      "<code>{{ count | pluralize: &quot;ticket&quot;, &quot;tickets&quot; }}</code> — returns the singular",
    );
    assertStringIncludes(
      html,
      "<code>{{ listing_names }}</code> — All listing names, joined with &quot;and&quot;",
    );
  });

  test("every settings link opens the advanced settings page", () => {
    const html = renderEmailGuide();
    assert(!html.includes('href="/admin/settings"'));
    assertStringIncludes(
      html,
      'href="/admin/settings-advanced#settings-email"',
    );
  });
});
