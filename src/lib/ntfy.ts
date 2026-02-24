/**
 * Ntfy error notification module
 * Sends error pings to a configured ntfy URL
 * Only includes domain and error code - no personal or encrypted data
 */

import { getAllowedDomain } from "#lib/config.ts";
import { getEnv } from "#lib/env.ts";

/**
 * Send an error notification to the configured ntfy URL
 * Returns a promise so callers can await delivery if needed.
 * Delivery failures are logged to console but never throw.
 */
export const sendNtfyError = async (code: string): Promise<void> => {
  const ntfyUrl = getEnv("NTFY_URL");
  if (!ntfyUrl) return;

  const domain = getAllowedDomain();

  try {
    await fetch(ntfyUrl, {
      method: "POST",
      headers: {
        "Title": `${domain} error`,
        "Tags": "warning",
      },
      body: code,
    });
  } catch {
    // biome-ignore lint/suspicious/noConsole: Can't use logError here (would cause infinite loop)
    console.error("[Error] E_NTFY_SEND");
  }
};
