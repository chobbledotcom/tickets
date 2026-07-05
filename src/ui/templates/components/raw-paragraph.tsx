/**
 * A `<p><Raw html={t(key, args)}/></p>` — renders an i18n'ed HTML fragment
 * (typically a markdown string run through `t()`) inside a paragraph.
 *
 * Several admin pages render blocks of pre-rendered HTML copy this way
 * (the bulk-email TypeExplainer, the domain-payment warning, the privacy
 * page, etc.). Without this helper, the `<p><Raw/></p>` shape was duplicated
 * enough to trip jscpd across files.
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";

export const rawParagraph = (
  key: string,
  args?: Record<string, unknown>,
): JSX.Element => (
  <p>
    <Raw html={t(key, args)} />
  </p>
);
