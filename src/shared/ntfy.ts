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
 * Returns a delivery result so durable callers can leave failed work pending.
 * Delivery failures are logged locally (via logErrorLocal) but never throw.
 */
export const sendNtfyError = async (
  code: string,
): Promise<"disabled" | "failed" | "sent"> => {
  const ntfyUrl = getEnv("NTFY_URL");
  if (!ntfyUrl) return "disabled";

  const domain = getEffectiveDomain();

  try {
    const response = await fetchText(ntfyUrl, {
      body: code,
      headers: {
        Tags: "warning",
        Title: `${domain} error`,
      },
      method: "POST",
    });
    if (!response.ok) {
      logErrorLocal({
        code: ErrorCode.CDN_REQUEST,
        detail: "ntfy send failed",
      });
      return "failed";
    }
    return "sent";
  } catch {
    logErrorLocal({ code: ErrorCode.CDN_REQUEST, detail: "ntfy send failed" });
    return "failed";
  }
};
