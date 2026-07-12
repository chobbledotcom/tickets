/**
 * A link that opens in a new browser tab. Always sent with `rel="noopener"`
 * so the opened page cannot reach back into ours.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

export const NewTabLink = ({
  href,
  children,
}: {
  href: string;
  children: Child;
}): JSX.Element => (
  <a href={href} rel="noopener" target="_blank">
    {children}
  </a>
);
