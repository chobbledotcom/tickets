import { expect } from "@std/expect";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { TEMPLATE_VARIABLES } from "#templates/components/email-template-reference.tsx";

/** What a JSX text node shows: escaped, exactly as the runtime escapes it.
 * A code carrying Liquid markup (e.g. `{% if %}`) holds `<`/`>`, which the
 * renderer turns into entities. */
export const shown = (text: string): string => escapeHtml(text);

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
