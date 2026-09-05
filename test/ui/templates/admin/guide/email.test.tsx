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

describe("guide > email sections", () => {
  test("the variables entry shows every declared variable with its description", () => {
    expectVariablesShown(renderEmailGuide());
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
