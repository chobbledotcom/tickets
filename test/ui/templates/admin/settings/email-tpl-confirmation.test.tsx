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
});
