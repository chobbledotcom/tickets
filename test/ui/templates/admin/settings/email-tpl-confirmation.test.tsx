import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { ConfirmationEmailTemplateForm } from "#templates/admin/settings/email-tpl-confirmation.tsx";
import { LOOP_EXAMPLE } from "#templates/components/email-template-reference.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import {
  expectVariablesShown,
  shown,
} from "#test-utils/email-template-reference.ts";

describe("confirmation email template form", () => {
  const html = String(ConfirmationEmailTemplateForm(advancedDefaultState));

  test("the reference table shows every declared variable with its description", () => {
    expectVariablesShown(html);
  });

  test("the reference shows the worked loop and the notes", () => {
    expect(html).toContain(`<pre>${shown(LOOP_EXAMPLE)}</pre>`);
    expect(html).toContain(t("settings.advanced.email_variables.filters_note"));
    expect(html).toContain(
      t("settings.advanced.email_variables.not_available"),
    );
  });

  test("the form wires its action, anchors, and links exactly", () => {
    expect(html).toContain(
      'action="/admin/settings/email-templates/confirmation"',
    );
    expect(html).toContain('id="settings-email-tpl-confirmation"');
    expect(html).toContain('<div class="table-scroll">');
    expect(html).toContain(
      'sent to attendees (<a href="/admin/guide#email-templates">template guide</a>). Uses <a href="https://liquidjs.com/" rel="noopener" target="_blank">Liquid</a> template syntax. Leave blank',
    );
  });
});
