/**
 * Ntfy error notification module
 * Sends error pings to a configured ntfy URL
 * Only includes domain and error code - no personal or encrypted data
 */

import { getEffectiveDomain } from "#shared/config.ts";
import { getEnv } from "#shared/env.ts";
import { fetchText } from "#shared/fetch.ts";
import { ErrorCode, logErrorLocal } from "#shared/logger.ts";

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
      body: code,
      headers: {
        Tags: "warning",
        Title: `${domain} error`,
      },
      method: "POST",
    });
  } catch {
    logErrorLocal({ code: ErrorCode.CDN_REQUEST, detail: "ntfy send failed" });
  }
};
