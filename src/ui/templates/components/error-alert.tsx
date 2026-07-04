/**
 * `<div class="error" role="alert"><Raw html={message}/></div>` — an inline
 * error notice rendered from an already-i18n'ed HTML string.
 *
 * Used by built-sites (no-renewal-tier, secrets panel) and by the backup
 * restore-confirm page (schema-mismatch warning); the per-site "open it
 * inline at the call site" version had drifted enough to trip jscpd.
 */

import { Raw } from "#shared/jsx/jsx-runtime.ts";

export const ErrorAlert = ({ message }: { message: string }): JSX.Element => (
  <div class="error" role="alert">
    <Raw html={message} />
  </div>
);
