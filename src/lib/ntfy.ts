/**
 * Ntfy error notification module
 * Sends error pings to a configured ntfy URL
 * Only includes domain and error code - no personal or encrypted data
 */

import { getEffectiveDomain } from "#lib/config.ts";
import { getEnv } from "#lib/env.ts";
import { ErrorCode, logErrorLocal } from "#lib/logger.ts";
import { fetchText } from "#lib/fetch.ts";

/**
 * Send an error notification to the configured ntfy URL
 * Returns a promise so callers can await delivery if needed.
 * Delivery failures are logged locally (via logErrorLocal) but never throw.
 */
export const sendNtfyError = async (code: string): Promise<void> => {
  const ntfyUrl = getEnv("NTFY_URL");
  if (!ntfyUrl) return;

  const domain = getEffectiveDomain();

  try {
    await fetchText(ntfyUrl, {
      method: "POST",
      headers: {
        Title: `${domain} error`,
        Tags: "warning",
      },
      body: code,
    });
  } catch {
    logErrorLocal({ code: ErrorCode.CDN_REQUEST, detail: "ntfy send failed" });
  }
};
