/**
 * Ntfy error notification module
 * Sends error pings to a configured ntfy URL
 * Only includes domain and error code - no personal or encrypted data
 */

import { getAllowedDomain } from "#lib/config.ts";
import { getEnv } from "#lib/env.ts";

/**
 * Send an error notification to the configured ntfy URL
 * Fire and forget - delivery failures are silently ignored
 */
export const sendNtfyError = (code: string): void => {
  const ntfyUrl = getEnv("NTFY_URL");
  if (!ntfyUrl) return;

  const domain = getAllowedDomain();

  fetch(ntfyUrl, {
    method: "POST",
    headers: {
      "Title": `${domain} error`,
      "Tags": "warning",
    },
    body: code,
  }).catch(() => {
    // Silently ignore ntfy delivery failures
  });
};
