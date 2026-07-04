/**
 * A prose panel: a `<div class="prose">` with an optional leading
 * `<strong>label</strong> {value}` paragraph followed by free-form body.
 *
 * Built-sites uses it for the secrets panel and renewal-tier section, and
 * bulk-email uses the same shape for the "provider sending unavailable"
 * notice (label="Sending disabled", value=reason). Pulling the shared shape
 * into one component stops the per-file `<div class="prose"><p>…</p>…</div>`
 * from drifting.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

export type ProsePanelProps = {
  /** Optional leading paragraph: `<strong>{label}</strong> {value}`. Omit
   *  for panels that start straight with their children. */
  label?: string;
  value?: Child;
  children?: Child;
};

export const ProsePanel = ({
  label,
  value,
  children,
}: ProsePanelProps): JSX.Element => (
  <div class="prose">
    {label !== undefined && (
      <p>
        <strong>{label}</strong> {value}
      </p>
    )}
    {children}
  </div>
);
