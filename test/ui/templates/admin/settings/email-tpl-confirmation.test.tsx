import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { ConfirmationEmailTemplateForm } from "#templates/admin/settings/email-tpl-confirmation.tsx";
import { LOOP_EXAMPLE } from "#templates/components/email-template-reference.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
    expectIncludesAll(html, [
      `<pre>${shown(LOOP_EXAMPLE)}</pre>`,
      t("settings.advanced.email_variables.filters_note"),
      t("settings.advanced.email_variables.not_available"),
    ]);
  });

  test("the form wires its action, anchors, and links exactly", () => {
    expectIncludesAll(html, [
      'action="/admin/settings/email-templates/confirmation"',
      'id="settings-email-tpl-confirmation"',
      '<div class="table-scroll">',
      'sent to attendees (<a href="/admin/guide#email-templates">template guide</a>). Uses <a href="https://liquidjs.com/" rel="noopener" target="_blank">Liquid</a> template syntax. Leave blank',
    ]);
  });
});
