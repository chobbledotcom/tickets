import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { emailSections } from "#templates/admin/guide/email.tsx";
import {
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";

const renderEmailGuide = (): string =>
  String(renderGuideSections(emailSections()));

/** What a `<code>` body shows: JSX escapes double quotes as entities. */
const shown = (code: string): string => code.replaceAll('"', "&quot;");

describe("guide > email sections", () => {
  test("the variables entry shows every declared variable with its description", () => {
    const html = renderEmailGuide();
    for (const [code, key] of TEMPLATE_VARIABLES) {
      expect(html).toContain(`<code>${shown(code)}</code>`);
      expect(html).toContain(
        shown(t(`settings.advanced.email_variables.${key}`)),
      );
    }
  });

  test("the variables entry shows the worked loop", () => {
    expect(renderEmailGuide()).toContain(
      `<pre><code>${shown(LOOP_EXAMPLE)}</code></pre>`,
    );
  });

  test("every settings link opens the advanced settings page", () => {
    const html = renderEmailGuide();
    expect(html).not.toContain('href="/admin/settings"');
    expect(html).toContain('href="/admin/settings-advanced#settings-email"');
  });
});
