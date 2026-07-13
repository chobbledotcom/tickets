/**
 * A `<p><Raw html={t(key, args)}/></p>` — renders an i18n'ed HTML fragment
 * (typically a markdown string run through `t()`) inside a paragraph.
 *
 * Several admin pages render blocks of pre-rendered HTML copy this way
 * (the bulk-email TypeExplainer, the domain-payment warning, the privacy
 * page, etc.). The paragraph markup itself lives in {@link RawParagraph};
 * this helper only adds the `t()` lookup.
 */

import { t } from "#i18n";
import { RawParagraph } from "#templates/components/prose-heading.tsx";

export const rawParagraph = (
  key: string,
  args?: Record<string, unknown>,
): JSX.Element => <RawParagraph html={t(key, args)} />;
