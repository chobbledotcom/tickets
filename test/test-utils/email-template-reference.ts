import { expect } from "@std/expect";
import { t } from "#i18n";
import { TEMPLATE_VARIABLES } from "#templates/components/email-template-reference.tsx";

/** What a JSX text node shows: double quotes escape as entities. */
export const shown = (text: string): string => text.replaceAll('"', "&quot;");

/** Assert a rendered page shows every declared template variable's code and
 * its description — the shared check behind the guide's and the settings
 * form's reference surfaces. */
export const expectVariablesShown = (html: string): void => {
  for (const [code, key] of TEMPLATE_VARIABLES) {
    expect(html).toContain(`<code>${shown(code)}</code>`);
    expect(html).toContain(
      shown(t(`settings.advanced.email_variables.${key}`)),
    );
  }
};
