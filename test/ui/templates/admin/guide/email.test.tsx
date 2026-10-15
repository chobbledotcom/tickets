import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { emailSections } from "#templates/admin/guide/email.tsx";
import { LOOP_EXAMPLE } from "#templates/components/email-template-reference.tsx";
import {
  expectVariablesShown,
  shown,
} from "#test-utils/email-template-reference.ts";
import { says } from "#test-utils/says.ts";

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
    says(html, `<pre><code>${shown(LOOP_EXAMPLE)}</code></pre>`);
    says(html, t("settings.advanced.email_variables.not_available"));
  });

  test("the host email note renders with its links and joins intact", () => {
    const html = String(renderGuideSections(emailSections(hostWithEmail)));
    says(
      html,
      "using <strong>Host Mail</strong> and the address <code>host@example.com</code>. You can use your own company instead",
    );
    says(
      html,
      'enter it in <a href="/admin/settings-advanced#settings-email">Advanced Settings</a>. Your own settings come first',
    );
  });

  test("the setup steps and section anchors render exactly", () => {
    const html = renderEmailGuide();
    says(
      html,
      'Go to <a href="/admin/settings-advanced#settings-email">Advanced Settings</a> and find the <strong>Email</strong> section',
    );
    says(html, "Choose your email company from the dropdown");
    says(html, '<h3 id="email">');
    says(html, '<h3 id="email-templates">');
    says(html, '<h3 id="bulk-email">');
  });

  test("the filters entry names both filters with their examples", () => {
    const html = renderEmailGuide();
    says(html, "<code>{{ amount | currency }}</code> — formats a number");
    says(
      html,
      "<code>{{ count | pluralize: &quot;ticket&quot;, &quot;tickets&quot; }}</code> — returns the singular",
    );
    says(
      html,
      "<code>{{ listing_names }}</code> — All listing names, joined with &quot;and&quot;",
    );
  });

  test("every settings link opens the advanced settings page", () => {
    const html = renderEmailGuide();
    assert(!html.includes('href="/admin/settings"'));
    says(html, 'href="/admin/settings-advanced#settings-email"');
  });
});
