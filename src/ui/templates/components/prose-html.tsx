/**
 * A prose block whose body starts with one authored-HTML paragraph — the
 * `*_html` copy keys. Extra children follow the paragraph in the same block.
 */

import { type Child, Raw } from "#jsx/jsx-runtime.ts";

export const ProseHtml = ({
  html,
  children,
}: {
  html: string;
  children?: Child;
}): JSX.Element => (
  <div class="prose">
    <Raw html={html} />
    {children}
  </div>
);
