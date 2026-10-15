import { t } from "#i18n";
import { TEMPLATE_VARIABLES } from "#templates/components/email-template-reference.tsx";
import { says } from "#test-utils/says.ts";

/** What a JSX text node shows: double quotes escape as entities. */
export const shown = (text: string): string => text.replaceAll('"', "&quot;");

/** Assert a rendered page shows every declared template variable's code and
 * its description — the shared check behind the guide's and the settings
 * form's reference surfaces. */
export const expectVariablesShown = (html: string): void => {
  for (const [code, key] of TEMPLATE_VARIABLES) {
    says(html, `<code>${shown(code)}</code>`);
    says(html, shown(t(`settings.advanced.email_variables.${key}`)));
  }
};
